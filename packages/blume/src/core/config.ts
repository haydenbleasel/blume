import { existsSync, readFileSync } from "node:fs";

import type { BlumeConfig } from "./config-input.ts";
import { applyDeploymentEnv } from "./deployment-env.ts";
import { BlumeError, diagnosticsFromZod } from "./diagnostics.ts";
import { createModuleLoader } from "./load-module.ts";
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
 * - `content` — where content lives (`root`, defaults to `docs`) and pluggable
 *   `sources` (filesystem, remote MDX, GitHub Releases, Sanity, Notion, or a
 *   custom `ContentSource`). Omit `sources` and the top-level `root` becomes one
 *   implicit filesystem source.
 * - `navigation` — sidebar, header `tabs`, `selectors` (version/language/product
 *   switchers), pinned `featured` links, and the `repo` link toggle. Omit
 *   `sidebar` to generate it from the content tree.
 * - `redirects` — `{ from, to, status }` rules (301 by default).
 * - `github` — `{ owner, repo, branch, dir }`, powering "Edit this page" links
 *   and the header repo link.
 *
 * **Appearance**
 * - `theme` — `accent` color, `fonts` (curated Google Font slugs), `radius`,
 *   `mode` (`system`/`light`/`dark`), `background`, and `strict` token mode.
 * - `markdown` — `code` (language icons, inline highlighting, line wrap),
 *   `headingAnchors`, `imageZoom`, and opt-in KaTeX `math`.
 * - `toc` — on-page table of contents; `true`/`false` or a heading-level range.
 * - `lastModified` — "Last updated" stamps from `git` history or frontmatter.
 * - `feedback` — the per-page "Was this helpful?" widget (on by default).
 * - `export` — reader-facing PDF/EPUB export actions (off by default).
 *
 * **Reference docs**
 * - `openapi` — native OpenAPI reference: one real page per operation, woven
 *   into the sidebar and search. Point `sources`/`spec` at your spec.
 * - `asyncapi` — AsyncAPI reference via the embedded Scalar renderer.
 *
 * **Search & AI**
 * - `search` — search backend `provider` (`orama` by default; `pagefind`,
 *   `algolia`, `typesense`, `orama-cloud`, `mixedbread`, or `none`) plus its
 *   credential block.
 * - `ai` — `ask` (the Ask AI chat endpoint and its provider/model) and `llmsTxt`
 *   (emit `llms.txt`).
 * - `mcp` — expose the docs as an MCP server for connecting agents.
 *
 * **SEO, feeds & analytics**
 * - `seo` — `og` images, `sitemap`, `robots`, `rss` feeds, `structuredData`
 *   JSON-LD, `agentReadability`, and robots `contentSignals`.
 * - `analytics` — PostHog, Vercel, or arbitrary `scripts` (Plausible, Fathom,
 *   GA, …).
 *
 * **Deployment & i18n**
 * - `deployment` — `site` URL (needed for absolute links, sitemaps, and OG),
 *   `adapter` (`vercel`/`node`/`netlify`/`cloudflare`), `output`
 *   (`static`/`server`), and `base` path. Auto-detected on Vercel/Netlify/
 *   Cloudflare from the platform env.
 * - `i18n` — opt-in multi-locale: `locales`, `defaultLocale`, `parser`
 *   (`dir` vs filename `dot` suffix), and per-locale UI overrides.
 *
 * - `examples` — where `<Component path>` previews resolve their source from
 *   (defaults to `examples/`; supports a glob for colocated registries).
 *
 * @example Zero-config — just render the Markdown under `docs/`.
 * ```ts
 * export default defineConfig({});
 * ```
 *
 * @example A production docs site with theming, search, and deployment.
 * ```ts
 * export default defineConfig({
 *   title: "Acme Docs",
 *   description: "Build faster with Acme.",
 *   logo: { image: "/logo.svg", text: "Acme" },
 *   github: { owner: "acme", repo: "acme" },
 *   theme: { accent: "violet", fonts: { body: "inter" }, radius: "lg" },
 *   navigation: {
 *     tabs: [
 *       { label: "Guides", path: "/guides" },
 *       { label: "API", path: "/api" },
 *     ],
 *   },
 *   search: { provider: "orama" },
 *   deployment: { site: "https://docs.acme.com", adapter: "vercel" },
 * });
 * ```
 *
 * @example An OpenAPI reference with the Ask AI assistant enabled.
 * ```ts
 * export default defineConfig({
 *   title: "Acme API",
 *   openapi: {
 *     enabled: true,
 *     route: "/reference",
 *     sources: [{ label: "Core", spec: "./openapi.json" }],
 *   },
 *   ai: { ask: { enabled: true }, llmsTxt: true },
 * });
 * ```
 *
 * @param config - The site configuration. All fields are optional.
 * @returns The same config object, typed for inference.
 * @see https://useblume.dev/docs for the full configuration reference.
 */
export const defineConfig = (config: BlumeConfig): BlumeConfig => config;

/** Result of loading + validating a project config. */
export interface ConfigLoadResult {
  config: ResolvedConfig;
  /** Absolute path of the config file used, or null when defaults were used. */
  configFile: string | null;
  diagnostics: Diagnostic[];
}

const importConfigModule = createModuleLoader();

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

  let raw: unknown = {};
  if (configFile) {
    try {
      raw = await importConfigModule(configFile);
    } catch (error) {
      throw new BlumeError({
        code: "BLUME_CONFIG_LOAD_FAILED",
        file: configFile,
        message: `Failed to load config: ${(error as Error).message}`,
        severity: "error",
      });
    }
  }

  const parsed = blumeConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Read the raw config text (when on disk) so errors carry a line/column.
    const source =
      configFile && existsSync(configFile)
        ? readFileSync(configFile, "utf-8")
        : undefined;
    const diagnostics = diagnosticsFromZod(parsed.error, {
      code: "BLUME_CONFIG_INVALID",
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
    throw new BlumeError(
      rest.length > 0
        ? {
            ...primary,
            message: `${primary.message}\n${rest.length} more config issue(s):\n${rest.map((d) => `  - ${d.message}`).join("\n")}`,
          }
        : primary
    );
  }

  // Resolve the canonical site URL, then SEO defaults that depend on it.
  // Precedence: explicit config > platform env (Vercel/Netlify/Cloudflare, via
  // applyDeploymentEnv) > the local dev server URL (dev only).
  const config = applyDeploymentEnv(parsed.data);
  const site = config.deployment.site ?? options.devServerUrl;

  // OG images need an absolute `og:image`, so they default on once a site URL
  // is known and off otherwise. An explicit `seo.og.enabled` always wins.
  const ogEnabled = config.seo.og.enabled ?? Boolean(site);

  return {
    config: {
      ...config,
      deployment: { ...config.deployment, site },
      seo: { ...config.seo, og: { ...config.seo.og, enabled: ogEnabled } },
    },
    configFile,
    diagnostics: [],
  };
};
