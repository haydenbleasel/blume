import { existsSync } from "node:fs";

import { isAbsolute, join, relative } from "pathe";

import { alertDiagnostics } from "./alert-diagnostics.ts";
import { normalizePath, withBasePath } from "./base-path.ts";
import { CHANGELOG_INDEX_ROUTE, hasChangelogIndex } from "./changelog-index.ts";
import { codeFenceDiagnostics } from "./code-fence-diagnostics.ts";
import { loadConfig } from "./config.ts";
import { customStaticRoutes, discoverPages } from "./custom-pages.ts";
import { directiveDiagnostics } from "./directive-diagnostics.ts";
import { formerRouteRedirects } from "./former-routes.ts";
import { buildContentGraph } from "./graph.ts";
import { i18nDiagnostics } from "./i18n.ts";
import { expandIncludes, hasIncludeStatements } from "./includes.ts";
import {
  datePublishedShallowWarning,
  gitFileDates,
  gitRepositoryRoot,
  isShallowGitRepository,
  lastModifiedShallowWarning,
  realPath,
  resolveLastModifiedConfig,
} from "./last-modified.ts";
import { routeSetFor } from "./locale-links.ts";
import type { RouteSet } from "./locale-links.ts";
import { buildManifest } from "./manifest.ts";
import { mirroredPage } from "./markdown-mirrors.ts";
import { mdxSyntaxCheck } from "./mdx-syntax.ts";
import { folderMetaDiagnostics } from "./meta-diagnostics.ts";
import { discoverFolderMeta, withGeneratedFolderMeta } from "./meta.ts";
import type { FolderMetaSource } from "./meta.ts";
import { resolveProjectContext } from "./project.ts";
import { isPatternPath, pathsUnderPattern } from "./redirect-patterns.ts";
import type { ResolvedConfig } from "./schema.ts";
import { normalizeEntry, strippedLineOffset } from "./sources/normalize.ts";
import { resolveDocsCollection, resolveSources } from "./sources/resolve.ts";
import type { SourceRuntime } from "./sources/resolve.ts";
import type {
  ContentSource,
  SourceEntry,
  SourceLoadResult,
} from "./sources/types.ts";
import { unmeasurableSvgDiagnostics } from "./svg-images.ts";
import { indexPageNames, syntaxDiagnostics } from "./syntax-diagnostics.ts";
import type {
  BlumeManifest,
  ContentGraph,
  Diagnostic,
  ExampleLookup,
  PageRecord,
  ProjectContext,
} from "./types.ts";
import {
  hasVariables,
  substituteVariables,
  undefinedVariables,
} from "./variables.ts";
import type { ContentVariables } from "./variables.ts";
import { versionsDiagnostics } from "./versions.ts";

/** Build mode: drafts are kept in `dev` and dropped in `build`. */
export type BuildMode = "dev" | "build";

/** CLI-supplied overrides applied over the loaded config (see `scanProject`). */
export interface ConfigOverrides {
  /** Override `content.root` (`blume dev --content-dir`). */
  contentRoot?: string;
}

/**
 * Whether `path` sits at or under `dir`. A relative result that is itself
 * absolute means a different drive root on Windows, which is outside too.
 */
export const isWithin = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return !(rel.startsWith("..") || isAbsolute(rel));
};

/** Apply CLI config overrides onto a resolved config (returns a new object). */
const applyConfigOverrides = (
  config: ResolvedConfig,
  overrides?: ConfigOverrides
): ResolvedConfig => {
  if (!overrides) {
    return config;
  }
  // `--content-dir` re-roots every filesystem source: with one (the
  // zero-config case) it is exactly the old `content.root` override, and
  // several must share a root anyway (see `resolveDocsCollection`).
  const { contentRoot } = overrides;
  const sources = contentRoot
    ? config.content.sources.map((source) =>
        source.kind === "filesystem"
          ? { ...source, options: { ...source.options, root: contentRoot } }
          : source
      )
    : config.content.sources;
  return {
    ...config,
    content: { ...config.content, sources },
  };
};

/** Everything Blume knows about a project after a full scan. */
export interface BlumeProject {
  mode: BuildMode;
  context: ProjectContext;
  config: ResolvedConfig;
  graph: ContentGraph;
  manifest: BlumeManifest;
  diagnostics: Diagnostic[];
  /**
   * Entries excluded from the graph because their frontmatter failed
   * validation, or (in a build) their MDX doesn't parse.
   */
  droppedPages: number;
  /**
   * The local `.mdx` files a build dropped because they don't parse, which
   * the docs collection leaves out so Astro never compiles them.
   */
  unparsable: string[];
  /** The instantiated content sources, for lazy entry reads (search/AI/raw). */
  sources: ContentSource[];
  /**
   * Whether the config file set `theme.fonts` itself (see
   * {@link ConfigLoadResult.themeFontsConfigured}); gates OG font derivation.
   */
  themeFontsConfigured: boolean;
  /**
   * Discovered `examples/` sources keyed by `<Component path>`, attached by the
   * runtime/eject layer after {@link scanProject} (example discovery is an Astro
   * concern, so core doesn't run it). Undefined until then; the agent-facing
   * Markdown downleveler reads it to turn `<Component path="…" />` into the
   * example's source. Empty when the project has no examples.
   */
  examples?: ExampleLookup;
}

/**
 * Guard the invariant that ties a filesystem page to the `docs` collection:
 * Astro ids each collection entry by its path relative to the collection base,
 * so `getEntry("docs", entryId)` only resolves when that entry id equals
 * `relative(base, file)`. A filesystem source ids entries relative to its own
 * root; when that root can't be the collection base (e.g. a second filesystem
 * source rooted elsewhere), the ids diverge and every one of that source's pages
 * would 404 in dev (a static build silently masks it). Emit a hard error naming
 * the mismatch so it can't ship, instead of a silent runtime failure. One
 * diagnostic per file (locale duplicates share a source path).
 */
const entryIdDiagnostics = (
  pages: PageRecord[],
  collectionBase: string
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    // Only filesystem entries render through the base-rooted `docs` collection;
    // staged sources carry their own id and collection.
    if (page.collection || !page.sourcePath || seen.has(page.sourcePath)) {
      continue;
    }
    seen.add(page.sourcePath);
    const expected = relative(collectionBase, page.sourcePath)
      .split("\\")
      .join("/");
    const entryId = page.entryId ?? page.source.ref;
    if (expected !== entryId) {
      diagnostics.push({
        code: "BLUME_ENTRY_ID_MISMATCH",
        file: page.sourcePath,
        message: `Content source "${page.source.name}" is rooted outside the docs collection base, so ${page.route} resolves entry id "${entryId}" but the collection would generate "${expected}" — the page would 404 at runtime.`,
        severity: "error",
        suggestion:
          "Use a single filesystem() source (the docs collection roots at it), or give every filesystem() source the same root and partition them with include globs — a root at a subdirectory of the first source's root still mismatches.",
      });
    }
  }
  return diagnostics;
};

/**
 * Funnel every loaded source's entries through the shared `normalizeEntry`,
 * collecting pages, diagnostics, and the count of entries dropped outright —
 * an entry that yields no pages but did yield diagnostics was rejected for
 * invalid frontmatter, and callers surface that count so a build with missing
 * pages can't read as clean. With `dropUnparsable`, an `.mdx` page whose own
 * text doesn't parse is dropped too, and its file listed in `unparsable` so
 * the docs collection leaves it out.
 */
const normalizeLoadedEntries = (
  loaded: ({ source: ContentSource } & SourceLoadResult)[],
  config: ResolvedConfig,
  dropUnparsable: boolean
) => {
  // Only thread `frontmatter.extend` / `content.types` through when a project
  // opts in, so the known-key split in `normalizeEntry` stays off the default
  // path.
  const frontmatterExtend =
    Object.keys(config.frontmatter.extend).length > 0
      ? config.frontmatter.extend
      : undefined;
  const declaredTypes = Object.entries(config.content.types).filter(
    ([, type]) => Object.keys(type.frontmatter).length > 0
  );
  const typeFrontmatter =
    declaredTypes.length > 0
      ? Object.fromEntries(
          declaredTypes.map(([name, type]) => [name, type.frontmatter])
        )
      : undefined;

  const pages: PageRecord[] = [];
  const allDiagnostics: Diagnostic[] = [];
  const syntaxErrors: Diagnostic[] = [];
  const unparsable: string[] = [];
  // Published entries, checked for other tools' syntax once every page is
  // known: a wiki link is reported when it names one.
  const published: { entry: SourceEntry; locale: string; source: string }[] =
    [];
  let droppedPages = 0;
  for (const { source, entries, diagnostics } of loaded) {
    allDiagnostics.push(...diagnostics);
    for (const entry of entries) {
      const syntax = mdxSyntaxCheck(entry, source.name, config.variables);
      syntaxErrors.push(...syntax.diagnostics);
      // A build drops a page whose MDX doesn't parse, as it does one whose
      // front matter fails: with --no-strict the rest of the site still
      // builds. Dev keeps it, so opening it shows the error in place.
      const drop = syntax.unparsable && dropUnparsable;
      if (drop && entry.sourcePath && !source.staged) {
        unparsable.push(entry.sourcePath);
      }
      const normalized = normalizeEntry(entry, {
        basePath: config.basePath,
        defaultType: config.content.defaultType,
        frontmatterExtend,
        i18n: config.i18n,
        source: {
          monolingual: source.monolingual,
          name: source.name,
          orderedNames: source.orderedNames,
          prefix: source.prefix,
          staged: source.staged,
        },
        typeFrontmatter,
        versions: config.versions,
      });
      const [page] = normalized.pages;
      if (page ? drop : normalized.diagnostics.length > 0) {
        droppedPages += 1;
      }
      if (!drop) {
        pages.push(...normalized.pages);
      }
      allDiagnostics.push(...normalized.diagnostics);
      if (page) {
        allDiagnostics.push(
          ...directiveDiagnostics(entry, source.name),
          ...codeFenceDiagnostics(entry, source.name),
          ...alertDiagnostics(entry, source.name)
        );
        published.push({ entry, locale: page.locale, source: source.name });
      }
    }
  }
  const names = indexPageNames(pages);
  for (const { entry, locale, source } of published) {
    allDiagnostics.push(...syntaxDiagnostics(entry, source, names, locale));
  }
  // A parse error gives way to a diagnostic as severe at its line, which
  // names the cause (`BLUME_MDX_CURLY_ANCHOR` for a `{#id}` heading marker,
  // `BLUME_MDX_ATTRIBUTE_LIST` in a partial).
  const covered = (diagnostic: Diagnostic): boolean =>
    allDiagnostics.some(
      (other) =>
        other.file === diagnostic.file &&
        other.line === diagnostic.line &&
        (other.severity === "error" ||
          (other.severity === "warning" && diagnostic.severity === "warning"))
    );
  allDiagnostics.push(...syntaxErrors.filter((error) => !covered(error)));
  return { diagnostics: allDiagnostics, droppedPages, pages, unparsable };
};

/**
 * The local sources' on-disk roots a `git log` pathspec can cover: those
 * inside the repository at `gitRoot`. A root outside it would fail the log
 * outright and can never yield dates. Compared by real path, since git spells
 * its toplevel with every symlink resolved (`/private/tmp/site` for a project
 * opened as `/tmp/site`); the roots themselves keep the project's spelling.
 */
const gitContentRoots = (
  sources: readonly ContentSource[],
  gitRoot: string | null
): string[] => {
  if (gitRoot === null) {
    return [];
  }
  const top = realPath(gitRoot);
  return sources
    .flatMap((source) => (source.contentRoot ? [source.contentRoot] : []))
    .filter((dir) => isWithin(top, realPath(dir)));
};

/** Whether a page's front matter dates its publication itself. */
const hasPublishedDate = (page: PageRecord): boolean =>
  Boolean(page.meta.date ?? page.meta.changelog?.date);

/**
 * Fill in each page's git dates — "last updated" under `lastModified: "git"`,
 * published under `seo.datePublished: "git"` — from one `git log`, and warn
 * when a shallow clone leaves pages undated. Frontmatter always wins; git
 * applies to filesystem entries, other sources supply dates on the entry.
 */
const applyGitDates = (
  pages: PageRecord[],
  sources: readonly ContentSource[],
  root: string,
  config: ResolvedConfig
): Diagnostic[] => {
  const lastModified = resolveLastModifiedConfig(config.lastModified);
  const gitModified = lastModified.enabled && lastModified.source === "git";
  const gitPublished = config.seo.datePublished === "git";
  if (!(gitModified || gitPublished)) {
    return [];
  }
  const fsPaths = pages
    .map((page) => page.sourcePath)
    .filter((path): path is string => path !== undefined);
  // The git pathspecs must cover where the pages actually live: each local
  // source's own on-disk root — a filesystem source's `root`, or a staged
  // local source's tree (an Obsidian vault) — which diverges from the global
  // `content.root`.
  const gitRoot = gitRepositoryRoot(root);
  const contentRoots = gitContentRoots(sources, gitRoot);
  const gitDates = gitFileDates(root, contentRoots, fsPaths, gitRoot);
  // Only pages the log could have dated count toward the shallow-clone
  // warnings — a page outside every covered root stays undated no matter how
  // deep the clone is, and the warning's suggested fix cannot help it.
  const datable = pages.filter(
    (page) =>
      page.sourcePath &&
      contentRoots.some((dir) => isWithin(dir, page.sourcePath ?? ""))
  );
  const warnings: Diagnostic[] = [];
  if (gitModified) {
    for (const page of pages) {
      if (!page.lastModified && page.sourcePath) {
        page.lastModified = gitDates.modified.get(page.sourcePath);
      }
    }
    // A shallow CI clone (Vercel, actions/checkout) silently drops most dates;
    // surface that instead of letting production diverge from local builds.
    warnings.push(
      ...lastModifiedShallowWarning(
        root,
        datable.filter((page) => !page.lastModified).length
      )
    );
  }
  if (gitPublished) {
    // A shallow clone's oldest commit is where it was cut, not where a page
    // began, so it dates nothing rather than every page wrongly.
    const shallow = isShallowGitRepository(root);
    for (const page of pages) {
      if (!(shallow || hasPublishedDate(page)) && page.sourcePath) {
        page.published = gitDates.published.get(page.sourcePath);
      }
    }
    if (shallow) {
      warnings.push(
        ...datePublishedShallowWarning(
          datable.filter((page) => !hasPublishedDate(page)).length
        )
      );
    }
  }
  return warnings;
};

/**
 * Run the full core pipeline for a project root: load config, resolve paths,
 * discover content and folder meta, build the graph, and assemble the manifest.
 * Collects all diagnostics without throwing on content-level problems so
 * callers can decide how strict to be.
 */
/** Narrows the logo config's image shorthand from its object form. */
const isLogoShorthand = (
  logo: NonNullable<ResolvedConfig["logo"]>
): logo is string => typeof logo === "string";

/** The configured brand link: `logo.href`, else the site root. */
const logoHref = (logo: ResolvedConfig["logo"]): string =>
  logo === undefined || isLogoShorthand(logo) ? "/" : (logo.href ?? "/");

/** Narrows the banner config's text shorthand from its object form. */
const isBannerShorthand = (
  banner: NonNullable<ResolvedConfig["banner"]>
): banner is string => typeof banner === "string";

/**
 * Report an entry's undefined content variables at their source lines, then
 * replace the defined ones in the text the scan extracts from: the expanded
 * text when includes were spliced (its `origins` map lines back to the file
 * each came from), else the body.
 */
const substituteEntryVariables = (
  entry: SourceEntry,
  variables: ContentVariables
): Diagnostic[] => {
  const { expanded } = entry;
  const text = expanded?.text ?? entry.body.text;
  const offset = expanded ? 0 : strippedLineOffset(entry.raw, entry.body.text);
  const diagnostics = undefinedVariables(text, variables).map(
    ({ line, name }): Diagnostic => {
      const origin = expanded?.origins[line - 1];
      return {
        code: "BLUME_UNDEFINED_VARIABLE",
        file: origin?.file ?? entry.sourcePath,
        line: origin?.line ?? line + offset,
        message: `{{${name}}} isn't a defined variable, so it would show as written.`,
        severity: "error",
        suggestion: `Define "${name}" under variables in blume.config.ts, or put it in inline code to show it as written.`,
      };
    }
  );
  if (expanded) {
    expanded.text = substituteVariables(expanded.text, variables);
  } else {
    entry.body.text = substituteVariables(entry.body.text, variables);
  }
  return diagnostics;
};

/** {@link substituteEntryVariables} over every loaded entry, when any are defined. */
const substituteLoadedVariables = (
  loaded: readonly SourceLoadResult[],
  variables: ContentVariables
): Diagnostic[] =>
  hasVariables(variables)
    ? loaded.flatMap(({ entries }) =>
        entries.flatMap((entry) => substituteEntryVariables(entry, variables))
      )
    : [];

/**
 * A pattern redirect that also matches a page. Hosts disagree on which
 * answers (Vercel and Cloudflare apply the rule ahead of the page, Netlify
 * and the Node server serve the page), so the pattern is rejected rather than
 * let the answer depend on the host. `pages` are the served page paths, which
 * carry `basePath`, as the based `from` does.
 *
 * An exact redirect from a page's own URL answers the same way everywhere:
 * Astro ranks its route above the page's catch-all, in dev and build alike,
 * and writes the redirect page where the page would go, so the page never
 * publishes. That's a warning rather than an error, since the outcome doesn't
 * depend on the host. So is one from a page's Markdown copy (`/guide.md`, or
 * the root's `/index.md`), which it takes over the same way. `mirrored` are
 * the routes served with copies: the content pages.
 */
const redirectPageDiagnostics = (
  config: ResolvedConfig,
  pages: readonly string[],
  mirrored: RouteSet,
  configFile: string | null
): Diagnostic[] =>
  config.redirects.flatMap((redirect): Diagnostic[] => {
    const from = withBasePath(config.basePath, redirect.from);
    if (!isPatternPath(redirect.from)) {
      const page = normalizePath(from);
      if (pages.includes(page)) {
        return [
          {
            code: "BLUME_REDIRECT_MATCHES_PAGE",
            file: configFile ?? undefined,
            message: `The redirect from ${redirect.from} is also the page ${page}, which never publishes: its URL redirects to ${redirect.to} instead.`,
            severity: "warning",
            suggestion:
              "If the page moved, delete it or give it a new slug; otherwise remove the redirect.",
          } satisfies Diagnostic,
        ];
      }
      const owner = mirroredPage(mirrored, page);
      return owner === undefined
        ? []
        : [
            {
              code: "BLUME_REDIRECT_MATCHES_PAGE",
              file: configFile ?? undefined,
              message: `The redirect from ${redirect.from} is also the Markdown copy of the page ${owner}, so that copy never publishes: its URL redirects to ${redirect.to} instead.`,
              severity: "warning",
              suggestion:
                "Remove the redirect: that URL serves the page's Markdown to agents.",
            } satisfies Diagnostic,
          ];
    }
    const matched = pathsUnderPattern(from, pages);
    const [first] = matched;
    if (first === undefined) {
      return [];
    }
    const more = matched.length > 1 ? ` and ${matched.length - 1} more` : "";
    return [
      {
        code: "BLUME_REDIRECT_MATCHES_PAGE",
        file: configFile ?? undefined,
        message: `The redirect from ${redirect.from} also matches the page ${first}${more}, which some hosts would redirect and others would serve.`,
        severity: "error",
        suggestion:
          "Narrow the pattern to the paths that moved, or move the pages out from under it.",
      } satisfies Diagnostic,
    ];
  });

/**
 * The config with the redirects sources ask for added after its own (see
 * `SourceLoadResult.redirects`), so every surface that reads
 * `config.redirects` — Astro's redirect pages, the host files, the link
 * checker — serves them alike. Each is repeated under every locale prefix
 * whose copy of the target page is served (a translation, or the fallback
 * copy), and is kept only where its target is a page and nothing else
 * answers for its `from`: a page there, or a configured redirect, wins.
 * `pages` are the served page paths, which carry `basePath`.
 */
const withSourceRedirects = (
  config: ResolvedConfig,
  loaded: readonly SourceLoadResult[],
  pages: RouteSet
): ResolvedConfig => {
  const requested = loaded.flatMap(({ redirects }) => redirects ?? []);
  if (requested.length === 0) {
    return config;
  }
  const served = (route: string): string =>
    normalizePath(withBasePath(config.basePath, route));
  const prefixes = [
    "",
    ...(config.i18n?.locales.map((locale) => `/${locale.code}`) ?? []),
  ];
  const taken = new Set(
    config.redirects.map((redirect) => served(redirect.from))
  );
  const added: ResolvedConfig["redirects"] = [];
  for (const redirect of requested) {
    for (const prefix of prefixes) {
      const from = `${prefix}${redirect.from}`;
      const to = `${prefix}${redirect.to}`;
      if (
        !pages.has(served(to)) ||
        pages.has(served(from)) ||
        taken.has(served(from))
      ) {
        continue;
      }
      taken.add(served(from));
      added.push({ from, status: 301, to });
    }
  }
  return added.length > 0
    ? { ...config, redirects: [...config.redirects, ...added] }
    : config;
};

/**
 * A `public/openapi.json` is served at `/openapi.json`, where Blume
 * publishes the OpenAPI description of the site's own JSON docs API: the
 * build stops generating that description, while the API catalog
 * (`/.well-known/api-catalog`) still lists `/openapi.json` as the docs API's
 * `service-desc`, so agents reading it get the project's file instead. Only
 * when the docs API is on; otherwise Blume publishes nothing there.
 */
const publicOpenApiDiagnostics = (
  config: ResolvedConfig,
  root: string
): Diagnostic[] => {
  const file = join(root, "public", "openapi.json");
  return config.agents.api && existsSync(file)
    ? [
        {
          code: "BLUME_PUBLIC_OPENAPI_JSON",
          file,
          message:
            "public/openapi.json is served at /openapi.json, where Blume publishes the OpenAPI description of the site's JSON docs API, so that description isn't generated, and /.well-known/api-catalog still lists /openapi.json as the docs API's description.",
          severity: "warning",
          suggestion:
            "Move the file to another path, like public/specs/openapi.json, and update what links to it. A spec an openapi() reference renders can live outside public/ altogether. Or set agents.api to false if the site shouldn't publish the JSON docs API.",
        },
      ]
    : [];
};

/** The configured banner link target, when the banner has a link. */
const bannerLinkHref = (
  banner: ResolvedConfig["banner"]
): string | undefined =>
  banner === undefined || isBannerShorthand(banner)
    ? undefined
    : banner.link?.href;

/**
 * The project's sources, before any of them loads: `beforeSources` sees the
 * config first, then each source validates itself (e.g. the filesystem
 * source checks its root exists), replacing the single hard `contentRoot`
 * check.
 */
const validatedSources = (
  config: ResolvedConfig,
  context: ProjectContext,
  runtime: SourceRuntime,
  beforeSources?: (config: ResolvedConfig) => void
): ContentSource[] => {
  beforeSources?.(config);
  const sources = resolveSources(config, context, runtime);
  for (const source of sources) {
    source.validate?.();
  }
  return sources;
};

export const scanProject = async (
  root: string,
  options: {
    devServerUrl?: string;
    mode?: BuildMode;
    preview?: boolean;
    refresh?: boolean;
    /** CLI overrides applied over the loaded config (e.g. `--output`). */
    overrides?: ConfigOverrides;
    /** Relocate the generated runtime (e.g. `.blume-verify` for isolation). */
    runtimeDir?: string;
    /**
     * Called with the resolved config before any source loads, so a command
     * can report an unset secret ahead of a fetch that fails without it: a
     * source that can't load fails the scan, and nothing after it runs.
     */
    beforeSources?: (config: ResolvedConfig) => void;
  } = {}
): Promise<BlumeProject> => {
  const mode = options.mode ?? "dev";
  const preview = options.preview ?? false;
  const configResult = await loadConfig(root, {
    devServerUrl: options.devServerUrl,
  });
  const config = applyConfigOverrides(configResult.config, options.overrides);
  const context = resolveProjectContext(root, config, {
    runtimeDir: options.runtimeDir,
  });
  const sources = validatedSources(
    config,
    context,
    { mode, preview, refresh: options.refresh },
    options.beforeSources
  );

  // Folder meta is discovered per filesystem source, under each source's own
  // root and keyed by its route prefix, so a prefixed/root-differing source's
  // `meta.ts` still lines up with its (prefixed) sidebar group path.
  const metaSources: FolderMetaSource[] = sources.flatMap((source) =>
    source.staged || !source.contentRoot
      ? []
      : [
          {
            exclude: source.exclude,
            include: source.include,
            prefix: source.prefix,
            root: source.contentRoot,
          },
        ]
  );

  // Run every source's `load()` in parallel, then funnel each entry through the
  // shared `normalizeEntry` so route mapping is identical regardless of origin.
  // Under the `dir` parser, non-default locales are top-level directories whose
  // meta keys must carry the locale in front of the source prefix (see
  // `discoverFolderMeta`).
  const localeDirs =
    config.i18n && config.i18n.parser === "dir"
      ? config.i18n.locales.flatMap((locale) =>
          locale.code === config.i18n?.defaultLocale ? [] : [locale.code]
        )
      : undefined;

  const [loaded, folderMeta] = await Promise.all([
    Promise.all(
      sources.map(async (source) => ({ source, ...(await source.load()) }))
    ),
    discoverFolderMeta(metaSources, {
      localeDirs,
      versionDirs: config.versions?.archived.map((version) => version.id),
    }),
  ]);

  // Expand `<include>` statements before normalization, so heading/link/
  // component extraction sees the spliced content every render surface shows.
  // Filesystem entries only: includes resolve as filesystem paths bounded by
  // the owning source's content root. Unresolvable statements stay verbatim
  // and surface as error diagnostics here.
  const includeDiagnostics: Diagnostic[] = [];
  await Promise.all(
    loaded.flatMap(({ source, entries }) => {
      if (source.staged || !source.contentRoot) {
        return [];
      }
      return entries.map(async (entry) => {
        if (!entry.sourcePath || !hasIncludeStatements(entry.body.text)) {
          return;
        }
        const expansion = await expandIncludes(entry.body.text, {
          contentRoot: source.contentRoot,
          lineOffset: strippedLineOffset(entry.raw, entry.body.text),
          sourcePath: entry.sourcePath,
        });
        entry.expanded = expansion;
        includeDiagnostics.push(...expansion.errors);
      });
    })
  );

  // Content variables: an undefined name in prose is an error at its source
  // line, and every defined one is replaced in the text headings, links, and
  // components are extracted from, so they match the rendered page.
  const variableDiagnostics = substituteLoadedVariables(
    loaded,
    config.variables
  );

  // Folder meta contributed by the sources themselves (the OpenAPI source
  // labels each tag directory with the spec's own tag name). It applies to
  // every locale, so it merges into the shared map — beneath user-authored
  // entries, whose own fields win while the generated ones fill the rest.
  const mergedFolderMeta = withGeneratedFolderMeta(
    folderMeta,
    new Map(
      loaded.flatMap(({ folderMeta: sourceMeta }) =>
        Object.entries(sourceMeta ?? {})
      )
    ),
    localeDirs
  );

  const {
    diagnostics: contentDiagnostics,
    droppedPages,
    pages: allPages,
    unparsable,
  } = normalizeLoadedEntries(loaded, config, mode === "build");

  // Checked against every page, drafts included: a `pages` entry naming a
  // draft still orders it wherever the draft renders.
  const metaDiagnostics = await folderMetaDiagnostics(folderMeta, allPages, {
    localeDirs,
    versionDirs: config.versions?.archived.map((version) => version.id),
  });

  // Drafts render in dev and in preview, but are excluded from production builds.
  const pages =
    mode === "build" && !preview
      ? allPages.filter((page) => !page.meta.draft)
      : allPages;

  // Resolve "last updated" and publication dates before the graph is built so
  // the manifest (which shares these page objects) picks them up.
  const gitDateWarnings = applyGitDates(pages, sources, context.root, config);

  // Custom `.astro` pages and the generated changelog index aren't content
  // pages, so name them for navigation: a `/changelog` tab should open the
  // timeline, not the newest entry, and a tab or brand link to a custom page
  // must stay on its route in every locale.
  const customPages = context.pagesRoot
    ? await discoverPages(context.pagesRoot)
    : [];
  const extraRoutes = new Set([
    ...customStaticRoutes(customPages),
    ...(hasChangelogIndex(pages, config) ? [CHANGELOG_INDEX_ROUTE] : []),
  ]);
  const graph = buildContentGraph(pages, {
    bannerHref: bannerLinkHref(config.banner),
    basePath: config.basePath,
    brandHref: logoHref(config.logo),
    extraRoutes,
    folderMeta: mergedFolderMeta.meta,
    i18n: config.i18n,
    navigation: config.navigation,
    sharedFolderMeta: mergedFolderMeta.shared,
    versions: config.versions,
  });
  const manifest = buildManifest({ config, context, graph });

  const i18nWarnings = config.i18n
    ? i18nDiagnostics(pages, config.i18n, config.versions)
    : [];
  const svgWarnings = await unmeasurableSvgDiagnostics(pages);
  const versionWarnings = config.versions
    ? versionsDiagnostics(pages, config.versions)
    : [];

  const servedPaths = [
    ...manifest.routes.map((route) => route.path),
    ...extraRoutes,
  ];
  // A date-named page's old URL, from before its name was kept whole,
  // redirects to its new one, beside the redirects the config lists.
  const redirects = [
    ...config.redirects,
    ...formerRouteRedirects(pages, new Set(servedPaths), config),
  ];

  return {
    // Then the routes the API references served under earlier versions'
    // rules redirect to where those operations live now.
    config: withSourceRedirects(
      redirects.length === config.redirects.length
        ? config
        : { ...config, redirects },
      loaded,
      new Set([...routeSetFor(manifest.routes), ...extraRoutes])
    ),
    context,
    diagnostics: [
      ...configResult.diagnostics,
      ...contentDiagnostics,
      ...includeDiagnostics,
      ...variableDiagnostics,
      ...folderMeta.diagnostics,
      ...metaDiagnostics,
      ...entryIdDiagnostics(
        pages,
        resolveDocsCollection(config, context.root).base
      ),
      ...graph.diagnostics,
      ...i18nWarnings,
      ...versionWarnings,
      ...gitDateWarnings,
      ...svgWarnings,
      ...publicOpenApiDiagnostics(config, context.root),
      ...redirectPageDiagnostics(
        config,
        servedPaths,
        routeSetFor(manifest.routes),
        context.configFile
      ),
    ],
    droppedPages,
    graph,
    manifest,
    mode,
    sources,
    themeFontsConfigured: configResult.themeFontsConfigured,
    unparsable,
  };
};
