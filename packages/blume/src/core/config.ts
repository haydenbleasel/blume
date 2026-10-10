import { existsSync, readFileSync } from "node:fs";

import { basename } from "pathe";
import { z } from "zod";

import { ACCENTS, invalidColorSettings } from "../theme/palette.ts";
import type { BlumeConfig } from "./config-input.ts";
import { applyDeploymentEnv } from "./deployment-env.ts";
import {
  BlumeError,
  diagnosticsFromIssues,
  diagnosticsFromZod,
} from "./diagnostics.ts";
import { createDefaultExportLoader } from "./load-module.ts";
import { findConfigFile } from "./project.ts";
import { blumeConfigSchema } from "./schema.ts";
import type { ResolvedConfig } from "./schema.ts";
import type { Diagnostic } from "./types.ts";

/**
 * Define a Blume site's configuration with full type-checking and editor
 * autocomplete. Place the call in `blume.config.ts` at your project root and
 * `export default` the result:
 *
 * ```ts
 * import { defineConfig } from "blume";
 *
 * export default defineConfig({
 *   title: "Acme Docs",
 *   description: "Everything you need to build with Acme.",
 * });
 * ```
 *
 * Every field is optional — an empty `defineConfig({})` produces a working
 * site from the Markdown/MDX in your `docs/` directory. Configure only what you
 * want to change; sensible defaults fill in the rest.
 *
 * This is an identity helper: it returns its input unchanged and exists purely
 * for type inference (and as a stable home for future plugin hooks). The object
 * is validated against the Blume schema when the CLI loads it.
 *
 * ## Top-level fields
 *
 * **Site identity**
 * - `title` — site title, shown in the header, `<title>`, and OG images.
 *   Defaults to `"Documentation"`.
 * - `description` — default meta description, used where a page sets none.
 * - `logo` — brand mark. A string is an image path/URL; the object form splits
 *   an `image` mark from wordmark `text` and can override the brand `href`.
 * - `banner` — site-wide announcement bar; a string, or `{ content, link,
 *   dismissible }`.
 *
 * **Content & navigation**
 * - `content` — where content lives: adapters from `blume/sources` under
 *   `sources` (`filesystem({ root })`, `mdxRemote({…})`, `githubReleases({…})`,
 *   `sanity({…})`, `notion({…})`, `contentful({…})`, `payload({…})`,
 *   `strapi({…})`, `obsidian({…})`, or `custom(source)`), or the
 *   zero-config shorthand `root`/`include`/`exclude`, which desugars to one
 *   `filesystem()` source and can't be combined with `sources`.
 * - `navigation` — sidebar, header `tabs`, `selectors` (version/language/product
 *   switchers), pinned `featured` links, header `actions` and the one `cta`,
 *   and the `repo` link (a toggle, or a URL). Omit `sidebar` to generate it
 *   from the content tree.
 * - `redirects` — `{ from, to, status }` rules (301 by default).
 * - `github` — `{ owner, repo, branch, dir, host, api }`, powering "Edit this
 *   page" links and the header repo link; `host` points them at a GitHub
 *   Enterprise instance, `api` overrides the REST base derived from it.
 *
 * **Appearance**
 * - `theme` — `accent` color, `fonts` (curated slugs, any provider family, or
 *   local font files), `radius`,
 *   `mode` (`system`/`light`/`dark`), and `background`.
 * - `markdown` — `code` (language icons, light/dark Shiki `theme`, line
 *   `wrap`), `externalLinks`, `headingAnchors`, and `imageZoom`.
 * - `toc` — on-page table of contents; `true`/`false` or a heading-level range.
 * - `lastModified` — "Last updated" stamps from `git` history or frontmatter.
 * - `feedback` — the per-page "Was this helpful?" widget (on by default).
 * - `export` — reader-facing PDF/EPUB export actions (off by default).
 *
 * **Reference docs**
 * - `reference` — API references as a list of adapters from
 *   `blume/reference`: `openapi({…})` and `asyncapi({…})` render native pages
 *   (one real page per operation, woven into the sidebar and search; AsyncAPI
 *   2.x specs are normalized to 3.x), `graphql({…})` renders a schema, and
 *   `scalar({…})` embeds the Scalar reference instead.
 *
 * **Search, AI & agents**
 * - `search` — a search adapter from `blume/search` (`orama()` by default;
 *   `flexsearch()`, `pagefind()`, `algolia({…})`, `oramaCloud({…})`,
 *   `typesense({…})`, `mixedbread({…})`, or `false`), or `{ provider,
 *   popular, indexing }` to add curated links and indexing settings.
 * - `ai` — what faces a model at read time: `assistant` (the chat assistant, with
 *   a provider adapter from `blume/ai` such as `gateway()` or `openrouter()`)
 *   and `openInChat` (the "Open in chat" page action).
 * - `agents` — the machine-readable surface: `llmsTxt`, the JSON `api`, the
 *   `mcp` server, published `skills`, `markdownComponents` (Markdown
 *   serializers for custom components), the `catalog` manifests,
 *   `agentReadability`, robots `contentSignals`, `webmcp`, and `webBotAuth`.
 *
 * **SEO, feeds & analytics**
 * - `seo` — `og` images, `sitemap`, `robots`, `rss` feeds, and
 *   `structuredData` JSON-LD.
 * - `analytics` — a list of adapters from `blume/analytics`, one per provider
 *   (`posthog()`, `googleAnalytics()`, `plausible()`, `fathom()`, `vercel()`,
 *   `cloudflare()`, …), or `script()` for anything without one.
 *
 * **Astro**
 * - `integrations` — Astro integrations appended after Blume's built-ins, in
 *   declaration order. Install and maintain each integration in the site.
 *
 * **Deployment & i18n**
 * - `deployment` — a host adapter from `blume/deploy` (`vercel()`, `node()`,
 *   `netlify()`, `cloudflare()`) for a server build, each taking `site`,
 *   `base`, and `output`; or `{ site, base }` for a static build anywhere.
 *   `site` is auto-detected on Vercel/Netlify/Cloudflare from the platform env.
 * - `i18n` — opt-in multi-locale: `locales`, `defaultLocale`, `parser`
 *   (`dir` vs filename `dot` suffix), and per-locale UI overrides.
 *
 * - `examples` — `<Component path>` previews: `source` (default `examples/`;
 *   supports a glob for colocated registries) and `css`, a stylesheet injected
 *   into the isolated preview frames (e.g. shadcn variables).
 *
 * @example Zero-config — just render the Markdown under `docs/`.
 * ```ts
 * export default defineConfig({});
 * ```
 *
 * @example A production docs site with theming, search, and deployment.
 * ```ts
 * import { vercel } from "blume/deploy";
 * import { orama } from "blume/search";
 *
 * export default defineConfig({
 *   title: "Acme Docs",
 *   description: "Build faster with Acme.",
 *   logo: { image: "/logo.svg", text: "Acme" },
 *   github: { owner: "acme", repo: "acme" },
 *   theme: { accent: "purple", fonts: { body: "inter" }, radius: "lg" },
 *   navigation: {
 *     tabs: [
 *       { label: "Guides", path: "/guides" },
 *       { label: "API", path: "/api" },
 *     ],
 *   },
 *   search: orama(),
 *   // A server build on Vercel.
 *   deployment: vercel({ site: "https://docs.acme.com" }),
 * });
 * ```
 *
 * @example An OpenAPI reference with the assistant enabled.
 * ```ts
 * import { openapi } from "blume/reference";
 *
 * export default defineConfig({
 *   title: "Acme API",
 *   reference: [
 *     openapi({
 *       route: "/reference",
 *       sources: [{ label: "Core", spec: "./openapi.json" }],
 *     }),
 *   ],
 *   agents: { llmsTxt: true },
 *   ai: { assistant: { enabled: true } },
 * });
 * ```
 *
 * @param config - The site configuration. All fields are optional.
 * @returns The same config object, typed for inference.
 * @see https://useblume.dev/docs for the full configuration reference.
 */
export const defineConfig = (config: BlumeConfig): BlumeConfig => config;

/**
 * A config that fails validation. `diagnostic` folds every issue into the one
 * message a command prints; `issues` keeps each on its own, with its own
 * line, for `blume upgrade`, which lists them one by one.
 */
export class ConfigValidationError extends BlumeError {
  readonly issues: Diagnostic[];

  constructor(diagnostic: Diagnostic, issues: Diagnostic[]) {
    super(diagnostic);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/** Result of loading + validating a project config. */
export interface ConfigLoadResult {
  config: ResolvedConfig;
  /** Absolute path of the config file used, or null when defaults were used. */
  configFile: string | null;
  diagnostics: Diagnostic[];
  /**
   * Whether the config file set `theme.fonts` itself. The schema always fills
   * the roles with defaults, so the resolved config can't tell an intentional
   * font choice from the fallback — and only intentional choices should flow
   * into derived surfaces like OG card fonts.
   */
  themeFontsConfigured: boolean;
}

const importConfigModule = createDefaultExportLoader();

/**
 * The slice of a user config module probed before schema defaults apply:
 * whether `theme.fonts` was actually set. `looseObject` keeps every other key
 * out of scope; a non-object at either level simply fails the probe. `fonts`
 * is optional here — Zod 4 treats a bare `z.unknown()` key as required, which
 * would fail the probe for every `theme` that doesn't set fonts.
 */
const themeFontsProbeSchema = z.looseObject({
  theme: z.looseObject({ fonts: z.unknown().optional() }).optional(),
});

const isPathSegment = (segment: PropertyKey): segment is string | number =>
  typeof segment !== "symbol";

/**
 * Where an issue is located in the config source: its own path, except that
 * an unknown key — which Zod reports on its parent's path — is located at the
 * key itself, so a removed field points at the line that sets it.
 */
const locationPath = (issue: z.core.$ZodIssue): (string | number)[] => [
  ...issue.path.filter(isPathSegment),
  ...(issue.code === "unrecognized_keys" ? issue.keys.slice(0, 1) : []),
];

/** Sort key for a config issue: the line that set the field, else last. */
const lineRank = (diagnostic: Diagnostic): number =>
  diagnostic.line ?? Number.MAX_SAFE_INTEGER;

/**
 * One diagnostic per config issue, each anchored to the config file and, when
 * the source is on disk, to the line and column that set the field. Issues on
 * the config's own top level (a removed top-level block) lead, since they name
 * the biggest moves; the rest read top to bottom, in source order.
 */
const configIssues = (
  error: z.ZodError,
  options: { file?: string; source?: string }
): Diagnostic[] => {
  const code = "BLUME_CONFIG_INVALID";
  const located = diagnosticsFromIssues(
    error.issues.map((issue) => ({
      message: issue.message,
      path: locationPath(issue),
    })),
    { code, source: options.source }
  );
  return diagnosticsFromZod(error, { code, ...options })
    .map((diagnostic, index) => ({
      ...diagnostic,
      column: located[index]?.column,
      line: located[index]?.line,
    }))
    .toSorted(
      (a, b) =>
        Number(Boolean(a.schemaPath)) - Number(Boolean(b.schemaPath)) ||
        lineRank(a) - lineRank(b)
    );
};

const COLOR_FORMS =
  "a hex value like #6340ac, rgb(), hsl(), oklch(), or a color name like rebeccapurple";

/**
 * A warning for each configured color that isn't a CSS color, at the line
 * that sets it. The schema has always taken any string, so this warns rather
 * than failing a build that used to pass.
 */
const colorDiagnostics = (
  config: ResolvedConfig,
  configFile: string | null
): Diagnostic[] => {
  const invalid = invalidColorSettings(config);
  if (invalid.length === 0) {
    return [];
  }
  const source =
    configFile && existsSync(configFile)
      ? readFileSync(configFile, "utf-8")
      : undefined;
  const located = diagnosticsFromIssues(
    invalid.map((setting) => ({
      message: `${JSON.stringify(setting.value)} isn't a CSS color, so ${
        setting.path[0] === "seo"
          ? "the social card renderer rejects it"
          : "browsers ignore the styles that use it"
      }.`,
      path: setting.path,
    })),
    {
      code: "BLUME_THEME_COLOR_INVALID",
      file: configFile ?? undefined,
      source,
    }
  );
  return located.map((diagnostic, index) => ({
    ...diagnostic,
    severity: "warning",
    suggestion: invalid[index]?.presets
      ? `Use a preset (${Object.keys(ACCENTS).join(", ")}) or a CSS color: ${COLOR_FORMS}.`
      : `Use a CSS color: ${COLOR_FORMS}.`,
  }));
};

/**
 * Load and validate the project config. When no config file exists, schema
 * defaults produce a fully resolved config so the zero-boilerplate path works.
 */
export const loadConfig = async (
  root: string,
  /**
   * Supplied only by `blume dev`: the local dev server URL, used as the
   * `deployment.site` fallback when none is configured or detected. Builds
   * never pass it, so production output can't end up pointing at localhost.
   */
  options: { devServerUrl?: string } = {}
): Promise<ConfigLoadResult> => {
  const configFile = findConfigFile(root);

  let raw: unknown;
  if (configFile) {
    try {
      raw = await importConfigModule(configFile);
    } catch (error) {
      // SAFETY: the module loader rejects with the thrown load/parse failure,
      // which Node surfaces as an Error; a non-Error rejection only degrades
      // the interpolated message.
      throw new BlumeError({
        code: "BLUME_CONFIG_LOAD_FAILED",
        file: configFile,
        message: `Failed to load config: ${(error as Error).message}`,
        severity: "error",
      });
    }
    // Validating whatever else the module holds would build a silent default
    // site (a bare `defineConfig({…})` call) or reject a named `config` export
    // as an unknown key, neither of which names the actual mistake.
    if (raw === undefined) {
      throw new BlumeError({
        code: "BLUME_CONFIG_INVALID",
        file: configFile,
        message: `${basename(configFile)} has no default export, so Blume can't read its config.`,
        severity: "error",
        suggestion:
          "Export the config as the file's default: `export default defineConfig({ … })`.",
      });
    }
  }

  // Read before parsing: schema defaults erase the set-vs-defaulted distinction.
  const probe = themeFontsProbeSchema.safeParse(raw);
  const themeFontsConfigured =
    probe.success && probe.data.theme?.fonts !== undefined;

  const parsed = blumeConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Read the raw config text (when on disk) so errors carry a line/column.
    const source =
      configFile && existsSync(configFile)
        ? readFileSync(configFile, "utf-8")
        : undefined;
    const diagnostics = configIssues(parsed.error, {
      file: configFile ?? undefined,
      source,
    });
    const [first, ...rest] = diagnostics;
    const primary = first ?? {
      code: "BLUME_CONFIG_INVALID",
      file: configFile ?? undefined,
      message: "Invalid Blume config.",
      severity: "error" as const,
    };
    // Surface every issue in one failing run — reporting only the first turns
    // a three-mistake config into three fix-rerun-fail loops.
    const moreIssues = rest.map((d) => `  - ${d.message}`).join("\n");
    const detail =
      rest.length > 0
        ? {
            ...primary,
            message: `${primary.message}\n${rest.length} more config issue(s):\n${moreIssues}`,
          }
        : primary;
    throw new ConfigValidationError(detail, diagnostics);
  }

  // Resolve the canonical site URL, then SEO defaults that depend on it.
  // Precedence: explicit config > platform env (Vercel/Netlify/Cloudflare, via
  // applyDeploymentEnv) > the local dev server URL (dev only).
  const config = applyDeploymentEnv(parsed.data);
  const site = config.deployment.options.site ?? options.devServerUrl;

  // OG images need an absolute `og:image`, so they default on once a site URL
  // is known and off otherwise — and off beside a default `seo.og.image`,
  // which every page shows instead of its card. An explicit `seo.og.enabled`
  // always wins.
  const ogEnabled =
    config.seo.og.enabled ?? (Boolean(site) && !config.seo.og.image);

  return {
    config: {
      ...config,
      deployment: site
        ? {
            ...config.deployment,
            options: { ...config.deployment.options, site },
          }
        : config.deployment,
      seo: { ...config.seo, og: { ...config.seo.og, enabled: ogEnabled } },
    },
    configFile,
    diagnostics: colorDiagnostics(config, configFile),
    themeFontsConfigured,
  };
};
