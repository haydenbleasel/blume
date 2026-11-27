import { readFile } from "node:fs/promises";

import { defineCommand } from "citty";
import { join } from "pathe";

import { discoverIslands } from "../../astro/islands.ts";
import {
  customStaticRoutes,
  discoverPages,
  generatedBlogTagRoutes,
  hasGeneratedBlog,
  hasGeneratedChangelog,
} from "../../astro/pages.ts";
import { normalizeBasePath } from "../../core/base-path.ts";
import { extractComponentAnchors } from "../../core/component-anchors.ts";
import {
  analyzeComponentOverrides,
  ComponentOverridesError,
} from "../../core/component-overrides.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { validateLinks } from "../../core/links.ts";
import { buildManifest } from "../../core/manifest.ts";
import { scanProject } from "../../core/project-graph.ts";
import { findComponentsFile } from "../../core/project.ts";
import { resolveDocsCollection } from "../../core/sources/collection.ts";
import type { MdxAnchorReader } from "../../core/sources/types.ts";
import type { Diagnostic } from "../../core/types.ts";
import { generatedFilePaths } from "../../deploy/generated-files.ts";
import { referenceRoutes } from "../../openapi/references.ts";
import { parseIgnoreFlag } from "../args.ts";
import { commandMeta } from "../command-meta.ts";
import { reportInternalError } from "../internal-error.ts";
import {
  flushStdout,
  logger,
  reportDiagnostics,
  reportDiagnosticsJson,
} from "../log.ts";

/**
 * The MDX tags the project renders with its own components: its islands and
 * the built-ins its `components.ts` overrides. `null` when `components.ts`
 * can't be planned, so which built-ins it replaces isn't known.
 */
const ownComponents = async (root: string): Promise<Set<string> | null> => {
  const componentsFile = findComponentsFile(root);
  try {
    const [islands, overrides] = await Promise.all([
      discoverIslands(root),
      componentsFile
        ? readFile(componentsFile, "utf-8").then(
            (source) => analyzeComponentOverrides(source, componentsFile).mdx
          )
        : [],
    ]);
    return new Set([
      ...islands.islands.map((island) => island.name),
      ...overrides.map((override) => override.key),
    ]);
  } catch (error) {
    if (error instanceof ComponentOverridesError) {
      return null;
    }
    throw error;
  }
};

/**
 * The reader for the anchors built-in components render (an accordion
 * item's id, a tab's), skipping the project's own components; none at all
 * when those can't be known.
 */
const componentAnchors = async (
  root: string
): Promise<MdxAnchorReader | undefined> => {
  const own = await ownComponents(root);
  return own
    ? (body, frontmatter) =>
        extractComponentAnchors(body, { frontmatter, ownComponents: own })
    : undefined;
};

export const validateCommand = defineCommand({
  args: {
    external: {
      description: "Check external (HTTP) links over the network.",
      type: "boolean",
    },
    ignore: {
      description:
        'With --external, skip external links whose URL matches this glob (e.g. "https://example.com/**"). Repeat it for more; internal links are always checked.',
      type: "string",
      valueHint: "glob",
    },
    json: {
      description: "Emit diagnostics as JSON on stdout (for CI/editors).",
      type: "boolean",
    },
    strict: {
      description: "Treat warnings as errors.",
      type: "boolean",
    },
  },
  meta: commandMeta.validate,
  async run({ args, rawArgs }) {
    const root = process.cwd();
    const ignore = parseIgnoreFlag(rawArgs);
    const diagnostics: Diagnostic[] = [];

    try {
      const project = await scanProject(root, {
        // Links may target what built-in components render; only this scan
        // reads those, so only it pays for the parse.
        mdxAnchors: await componentAnchors(root),
        mode: "build",
      });
      // Surface content/graph problems too: a page that fails to parse is a
      // link-validation blind spot, so silently passing would be misleading.
      diagnostics.push(...project.diagnostics);

      // Custom `.astro` pages, reference routes (a `scalar()` page), and the
      // generated changelog and blog pages are servable routes the content
      // graph can't see — without them, a docs link to e.g. a custom landing
      // page fails as BLUME_BROKEN_LINK.
      const userPages = project.context.pagesRoot
        ? await discoverPages(project.context.pagesRoot)
        : [];
      const extraRoutes = [
        ...customStaticRoutes(userPages),
        ...referenceRoutes(project.config),
      ];
      if (hasGeneratedChangelog(project, userPages)) {
        extraRoutes.push("/changelog");
      }
      if (hasGeneratedBlog(project, userPages)) {
        extraRoutes.push("/blog");
      }
      extraRoutes.push(...generatedBlogTagRoutes(project, userPages));

      // Fallback-materialized locale routes (an untranslated page prerendered
      // at its localized URL) are servable but absent from the content graph —
      // without them a link to an untranslated sibling under a non-default
      // locale fails as BLUME_BROKEN_LINK even though the built site serves it.
      if (project.config.i18n) {
        const manifest = buildManifest({
          config: project.config,
          context: project.context,
          graph: project.graph,
        });
        extraRoutes.push(
          ...manifest.routes.flatMap((route) =>
            route.fallback ? [route.path] : []
          )
        );
      }

      // Links to `public/` files and to the files the build generates
      // (`/llms.txt`, `/sitemap.xml`) resolve too. With no `public/` folder,
      // the site ships no public files, so links to one are reported.
      diagnostics.push(
        ...(await validateLinks(project.graph, {
          basePath: project.config.basePath,
          checkExternal: Boolean(args.external),
          configFile: project.context.configFile ?? undefined,
          contentRoot: resolveDocsCollection(project.config, root).base,
          deployBase: normalizeBasePath(project.config.deployment.options.base),
          extraRoutes,
          generatedFiles: generatedFilePaths(project),
          i18n: project.config.i18n,
          ignore,
          publicDir: join(root, "public"),
          redirects: project.config.redirects,
        }))
      );
    } catch (error) {
      if (error instanceof BlumeError) {
        diagnostics.push(error.diagnostic);
      } else {
        reportInternalError(error);
        process.exit(1);
      }
    }

    // `--strict` escalates warnings to failures; info-level notes stay
    // advisory.
    const strictFailure =
      Boolean(args.strict) &&
      diagnostics.some((diagnostic) => diagnostic.severity !== "info");

    if (args.json) {
      // Drain stdout before exiting non-zero: `process.exit` would otherwise
      // truncate the JSON payload mid-write when stdout is a pipe — exactly how
      // `--json` is consumed in CI/editors.
      const hadErrors = reportDiagnosticsJson(diagnostics, root);
      if (hadErrors || strictFailure) {
        await flushStdout();
        process.exit(1);
      }
      return;
    }

    const hadErrors = reportDiagnostics(diagnostics, root);
    if (diagnostics.length === 0) {
      logger.success("No broken links found.");
    }
    if (hadErrors || strictFailure) {
      // Set the code and return rather than `process.exit`, which doesn't wait
      // for a piped stderr: a long diagnostic list would be cut off.
      process.exitCode = 1;
    }
  },
});
