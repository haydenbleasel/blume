import { mkdir, readFile, writeFile } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, extname, isAbsolute, join, relative, resolve } from "pathe";

import type { BlumeProject } from "../core/project-graph.ts";
import type { PageRecord } from "../core/types.ts";
import { rewriteMintlifyAsyncApiPage } from "../markdown/mintlify-asyncapi.ts";
import { rewriteMintlifyManualApiPage } from "../markdown/mintlify-manual-api.ts";
import { rewriteMintlifyOpenApiSchemaPage } from "../markdown/mintlify-openapi.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
} from "../markdown/mintlify-snippets.ts";

const MDX_ESM_LINE = /^(?:import|export)\s.+$/gmu;
const VISIBILITY_BLOCK =
  /<Visibility\b(?<attributes>[^>]*)>(?<content>[\s\S]*?)<\/Visibility>/giu;
const VISIBILITY_SELF_CLOSING = /<Visibility\b[^>]*\/>/giu;
const VISIBILITY_FOR_QUOTED = /\bfor\s*=\s*["'](?<audience>[^"']+)["']/iu;
const VISIBILITY_FOR_EXPRESSION =
  /\bfor\s*=\s*\{\s*["'](?<audience>[^"']+)["']\s*\}/iu;
const H1 = /^#\s+/mu;
const REMOTE_SOURCE = /^https?:\/\//iu;

interface ApiSchemaSource {
  kind: "AsyncAPI" | "OpenAPI";
  source: string;
}

const isMintlifyProject = (project: BlumeProject): boolean =>
  project.context.configFile?.endsWith("docs.json") === true;

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const markdownRouteForPage = (route: string): string =>
  route === "/" ? "/index.md" : `${route.replace(/\/$/u, "")}.md`;

export const markdownUrlForPage = (route: string, site?: string): string => {
  const markdownRoute = markdownRouteForPage(route);
  return site ? `${site.replace(/\/$/u, "")}${markdownRoute}` : markdownRoute;
};

const markdownOutputPath = (outDir: string, route: string): string =>
  join(outDir, markdownRouteForPage(route).slice(1));

const pageAccessGroups = (page: PageRecord): string[] => {
  const { groups } = page.meta as { groups?: unknown };
  if (Array.isArray(groups)) {
    return groups.filter((group): group is string => typeof group === "string");
  }
  return typeof groups === "string" ? [groups] : [];
};

export const isPublicAgentPage = (page: PageRecord): boolean =>
  pageAccessGroups(page).length === 0 ||
  (page.meta as { public?: unknown }).public === true;

const routeMatchesDirectory = (route: string, directory: string): boolean => {
  const normalized = directory.replaceAll(/^\/+|\/+$/gu, "");
  const prefix = normalized ? `/${normalized}` : "/";
  return prefix === "/"
    ? route === "/"
    : route === prefix || route.startsWith(`${prefix}/`);
};

const apiSchemasForPage = (
  project: BlumeProject,
  page: PageRecord
): ApiSchemaSource[] => {
  const seen = new Set<string>();
  const add = (item: ApiSchemaSource): ApiSchemaSource[] => {
    const key = `${item.kind}\u0000${item.source}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [item];
  };

  return [
    ...project.config.api.openapi.flatMap((spec) =>
      routeMatchesDirectory(page.route, spec.directory)
        ? add({ kind: "OpenAPI", source: spec.source })
        : []
    ),
    ...project.config.api.asyncapi.flatMap((spec) =>
      routeMatchesDirectory(page.route, spec.directory)
        ? add({ kind: "AsyncAPI", source: spec.source })
        : []
    ),
  ];
};

const localSchemaSource = (
  project: BlumeProject,
  source: string
): string | undefined => {
  if (REMOTE_SOURCE.test(source)) {
    return undefined;
  }

  const { root } = project.context;
  const mintlifyRootRelative =
    isMintlifyProject(project) && source.startsWith("/");
  let target = join(root, source);
  if (mintlifyRootRelative) {
    target = join(root, source.slice(1));
  } else if (isAbsolute(source)) {
    target = source;
  }

  const absolute = resolve(target);
  return isInsideRoot(root, absolute) ? absolute : undefined;
};

const schemaLanguage = (source: string): string => {
  const sourcePath = REMOTE_SOURCE.test(source)
    ? (() => {
        try {
          return new URL(source).pathname;
        } catch {
          return source;
        }
      })()
    : source;
  const ext = extname(sourcePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    return "yaml";
  }
  if (ext === ".json") {
    return "json";
  }
  return "";
};

const readRemoteSchema = async (
  source: string
): Promise<string | undefined> => {
  try {
    const response = await fetch(source);
    if (!response.ok) {
      return undefined;
    }
    const raw = await response.text();
    return raw.trim();
  } catch {
    return undefined;
  }
};

const readSchemaSource = async (
  project: BlumeProject,
  source: string
): Promise<string | undefined> => {
  if (REMOTE_SOURCE.test(source)) {
    return readRemoteSchema(source);
  }

  const local = localSchemaSource(project, source);
  if (!local) {
    return undefined;
  }

  try {
    const raw = await readFile(local, "utf-8");
    return raw.trim();
  } catch {
    return undefined;
  }
};

export const sourceForMarkdown = async (
  project: BlumeProject,
  page: PageRecord
): Promise<string> => {
  const raw = await readFile(page.sourcePath, "utf-8");
  if (!isMintlifyProject(project)) {
    return raw;
  }

  const withSnippets = await rewriteMintlifyMarkdownSnippets(raw, {
    filePath: page.sourcePath,
    root: project.context.root,
  });
  const withSnippetVariables = await rewriteMintlifySnippetVariables(
    withSnippets,
    {
      filePath: page.sourcePath,
      root: project.context.root,
    }
  );
  const withSchema = await rewriteMintlifyOpenApiSchemaPage(
    withSnippetVariables,
    {
      filePath: page.sourcePath,
      generation: {
        examples: project.config.api.examples,
        params: project.config.api.params,
      },
      root: project.context.root,
      specs: project.config.api.openapi,
    }
  );
  const withManualApi = rewriteMintlifyManualApiPage(withSchema, {
    api: project.config.api,
  });
  const withAsyncApi = await rewriteMintlifyAsyncApiPage(withManualApi, {
    root: project.context.root,
    specs: project.config.api.asyncapi,
  });
  return rewriteMintlifyGlobalVariables(withAsyncApi, project.config.variables);
};

/**
 * Map every route to its Markdown source. Native Blume projects get the source
 * file verbatim; Mintlify projects get the same lightweight rewrites used by
 * the generated Markdown exports so snippets and local API pages stay visible.
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, string>> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));
  const entries = await Promise.all(
    project.manifest.routes.map(async (route) => {
      const page = pageById.get(route.id);
      return [
        route.path,
        page
          ? await sourceForMarkdown(project, page)
          : await readFile(route.sourcePath, "utf-8"),
      ] as const;
    })
  );
  return Object.fromEntries(entries);
};

const visibilityAudience = (attributes: string): string => {
  const match =
    attributes.match(VISIBILITY_FOR_QUOTED) ??
    attributes.match(VISIBILITY_FOR_EXPRESSION);
  return (match?.groups?.audience ?? "humans").toLowerCase();
};

const applyAgentVisibility = (markdown: string): string => {
  let previous = "";
  let current = markdown;
  while (current !== previous) {
    previous = current;
    current = current.replace(
      VISIBILITY_BLOCK,
      (_match, attributes: string, content: string) =>
        visibilityAudience(attributes) === "agents" ? content : ""
    );
  }
  return current.replaceAll(VISIBILITY_SELF_CLOSING, "");
};

const apiSchemaMarkdown = async (
  project: BlumeProject,
  page: PageRecord
): Promise<string> => {
  if (!project.config.markdown.schema) {
    return "";
  }

  const sections = await Promise.all(
    apiSchemasForPage(project, page).map(async (schema) => {
      const raw = await readSchemaSource(project, schema.source);
      const lines = [
        `## ${schema.kind} schema`,
        "",
        `Source: ${schema.source}`,
      ];
      if (raw) {
        lines.push("", `\`\`\`${schemaLanguage(schema.source)}`, raw, "```");
      }
      return lines.join("\n");
    })
  );
  return sections.join("\n\n");
};

/** Build the Markdown page body used for Mintlify-style `.md` exports. */
export const buildPageMarkdown = async (
  project: BlumeProject,
  page: PageRecord
): Promise<string> => {
  const source = await sourceForMarkdown(project, page);
  const body = applyAgentVisibility(matter(source).content)
    .replaceAll(MDX_ESM_LINE, "")
    .trim();
  const withTitle = H1.test(body) ? body : `# ${page.title}\n\n${body}`;
  const schemas = await apiSchemaMarkdown(project, page);
  return [withTitle, schemas]
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
};

/** Write one `.md` file for every indexable route in the project. */
export const writeMarkdownExports = async (
  project: BlumeProject,
  outDir: string
): Promise<number> => {
  const pageById = new Map(project.graph.pages.map((page) => [page.id, page]));
  const publicRoutes = project.manifest.routes.filter((route) => {
    const page = pageById.get(route.id);
    return route.indexable && page !== undefined && isPublicAgentPage(page);
  });

  await Promise.all(
    publicRoutes.map(async (route) => {
      const page = pageById.get(route.id);
      if (!page) {
        return;
      }
      const output = markdownOutputPath(outDir, route.path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, await buildPageMarkdown(project, page), "utf-8");
    })
  );

  return publicRoutes.length;
};
