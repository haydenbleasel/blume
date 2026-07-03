import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { dirname, join } from "pathe";
import { glob } from "tinyglobby";

import { ensureGitignore } from "../../core/gitignore.ts";
import type { BlumeConfig } from "../../core/schema.ts";
import { ensurePackageJson } from "../shared.ts";
import { assetSegments } from "./assets.ts";
import { loadMintlifyConfig, partitionMintlifyRedirects } from "./config.ts";
import { mintlifyI18n } from "./i18n.ts";
import { transformMintlifyContent } from "./transform.ts";

export interface MintlifyMigrationResult {
  moved: number;
  warnings: string[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasFontFamily = (value: unknown): boolean => {
  const object = asRecord(value);
  if (!object) {
    return false;
  }
  const named = (child: unknown): boolean =>
    typeof asRecord(child)?.family === "string";
  return (
    typeof object.family === "string" ||
    named(object.heading) ||
    named(object.body)
  );
};

/**
 * Warn about Mintlify site chrome that Blume's config doesn't model, so it isn't
 * dropped silently: header links (`navbar.links`/`navbar.primary`), footer
 * socials (`footer.socials`), and fonts outside Blume's curated Google set. The
 * contextual page menu and last-updated timestamp are covered by Blume defaults
 * (page actions, git-derived dates), so they need no warning.
 */
const droppedChromeWarnings = (
  spec: Record<string, unknown>,
  config: BlumeConfig
): string[] => {
  const warnings: string[] = [];
  const navbar = asRecord(spec.navbar);
  if (navbar && (navbar.links || navbar.primary)) {
    warnings.push(
      "Header links (navbar.links/navbar.primary) have no blume.config equivalent and were dropped; re-add them with navigation.tabs or a Header layout override."
    );
  }
  if (asRecord(spec.footer)?.socials) {
    warnings.push(
      "Footer social links (footer.socials) have no blume.config equivalent and were dropped; add them with a Footer layout override."
    );
  }
  if (hasFontFamily(spec.fonts ?? spec.font) && !config.theme?.fonts) {
    warnings.push(
      "docs.json font family isn't in Blume's curated Google Fonts set; set theme.fonts to a supported slug or add @font-face rules in theme.css."
    );
  }
  return warnings;
};

/**
 * Warn about dynamic (wildcard/param) redirects the migrator dropped. Blume
 * redirects are static path-to-path, so a `:slug*`/`:id` source becomes an
 * unroutable Astro destination — kept ones crash the build. Point the user at
 * host-level rules that do support wildcards.
 */
const droppedRedirectWarnings = (spec: Record<string, unknown>): string[] => {
  const { dropped } = partitionMintlifyRedirects(spec);
  if (dropped.length === 0) {
    return [];
  }
  return [
    `Dropped ${dropped.length} dynamic redirect(s) Blume can't model as static path-to-path (${dropped.join(", ")}); re-add them as host-level rules (e.g. _redirects or vercel.json).`,
  ];
};

/** Recursively drop `undefined`, empty arrays, and empty objects. */
const prune = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(prune);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const pruned = prune(raw);
      if (pruned === undefined) {
        continue;
      }
      if (Array.isArray(pruned) && pruned.length === 0) {
        continue;
      }
      if (
        pruned &&
        typeof pruned === "object" &&
        !Array.isArray(pruned) &&
        Object.keys(pruned).length === 0
      ) {
        continue;
      }
      out[key] = pruned;
    }
    return out;
  }
  return value;
};

const writeBlumeConfig = async (
  root: string,
  config: BlumeConfig
): Promise<void> => {
  const body = `import { defineConfig } from "blume";\n\nexport default defineConfig(${JSON.stringify(prune(config), null, 2)});\n`;
  await writeFile(join(root, "blume.config.ts"), body, "utf-8");
};

interface RelocatedAssets {
  /** Top-level dirs served in place via `content.assets` (no files moved). */
  served: string[];
  /** Top-level files moved under `public/`. */
  moved: string[];
}

/**
 * Make referenced top-level assets resolvable in Blume. Directories (e.g.
 * Mintlify's `images/`) are left in place and served via `content.assets`, so
 * the migration doesn't churn every file under them; loose top-level files
 * (a root `favicon.png`, `logo.png`) are moved under `public/` since a mount
 * points at a directory.
 */
const relocateAssets = async (
  root: string,
  segments: string[]
): Promise<RelocatedAssets> => {
  const served: string[] = [];
  const moved: string[] = [];
  for (const segment of segments) {
    const source = join(root, segment);
    if (!existsSync(source) || segment === "public") {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential fs stats
    const stats = await stat(source);
    if (stats.isDirectory()) {
      served.push(segment);
      continue;
    }
    const dest = join(root, "public", segment);
    if (existsSync(dest)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential fs moves
    await mkdir(join(root, "public"), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- sequential fs moves
    await rename(source, dest);
    moved.push(segment);
  }
  return { moved, served };
};

/**
 * Fold relocated assets into the config (served dirs become `content.assets`)
 * and record what happened. Served dirs stay in place; only loose files moved.
 */
const applyRelocatedAssets = (
  config: BlumeConfig,
  assets: RelocatedAssets,
  warnings: string[]
): void => {
  if (assets.served.length > 0) {
    config.content = {
      ...config.content,
      assets: [
        ...new Set([...(config.content?.assets ?? []), ...assets.served]),
      ],
    };
    warnings.push(
      `Kept asset dir(s) in place, served via content.assets: ${assets.served.join(", ")}.`
    );
  }
  if (assets.moved.length > 0) {
    warnings.push(`Moved assets into public/: ${assets.moved.join(", ")}.`);
  }
};

/**
 * Remove the foreign Mintlify config now that it's been translated into
 * `blume.config.ts`. Leaving `docs.json`/`mint.json` on disk keeps the project a
 * bridge-mode candidate: `detectMintlifyBridge` fires on any later run where a
 * `blume.config.*` is absent (e.g. the config is deleted to re-run the
 * migration), silently serving the *un-migrated* Mintlify project instead of the
 * converted one. Removing it makes the conversion permanent — matching the
 * migrator's promise and how it already deletes inlined snippets.
 */
const removeForeignConfig = async (
  root: string,
  warnings: string[]
): Promise<void> => {
  const removed: string[] = [];
  for (const name of ["docs.json", "mint.json"]) {
    const file = join(root, name);
    if (existsSync(file)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fs removes
      await rm(file, { force: true });
      removed.push(name);
    }
  }
  if (removed.length > 0) {
    warnings.push(
      `Removed ${removed.join(", ")} (translated to blume.config.ts) so "blume dev" no longer falls back to Mintlify bridge mode.`
    );
  }
};

/**
 * Scaffold the project files a config-only Mintlify repo lacks: a runnable
 * `package.json` (it ships no npm manifest) and a `.gitignore` for Blume's
 * generated `.blume/` runtime and `dist/` build output. Both are idempotent —
 * an existing file is extended, not overwritten — and noted in the warnings.
 */
const scaffoldProjectFiles = async (
  root: string,
  warnings: string[]
): Promise<void> => {
  if (await ensurePackageJson(root)) {
    warnings.push(
      "Created a package.json with blume as a dependency; run `npm install`, then `npm run dev`."
    );
  }
  const ignored = await ensureGitignore(root, [".blume/", "dist/"]);
  if (ignored.length > 0) {
    warnings.push(`Added ${ignored.join(", ")} to .gitignore.`);
  }
};

/**
 * Delete the inlined markdown snippets. Component files (e.g. `.jsx`) are kept
 * because their imports were rewritten to resolve against `/snippets`.
 */
const cleanupSnippets = async (
  root: string,
  kept: Set<string>,
  warnings: string[]
): Promise<void> => {
  const dir = join(root, "snippets");
  if (!existsSync(dir)) {
    return;
  }
  const markdown = await glob(["**/*.{md,mdx}"], { absolute: true, cwd: dir });
  for (const file of markdown) {
    // oxlint-disable-next-line no-await-in-loop -- sequential fs removes
    await rm(file, { force: true });
  }
  const remaining = await glob(["**/*"], { cwd: dir, dot: true });
  if (remaining.length === 0) {
    await rm(dir, { force: true, recursive: true });
    warnings.push("Inlined and removed the /snippets directory.");
  } else {
    warnings.push(
      `Inlined markdown snippets; kept ${remaining.length} component file(s) under /snippets.`
    );
  }
  if (kept.size > 0) {
    warnings.push(
      `Rewrote ${kept.size} component snippet import(s) to relative paths; verify they resolve.`
    );
  }
};

/**
 * Migrate a Mintlify project to Blume: translate `docs.json`/`mint.json` into
 * `blume.config.ts`, rewrite every page to idiomatic Blume MDX in place, and
 * relocate static assets. Content stays at the project root (`content.root`
 * is `"."`).
 */
export const migrateMintlifyProject = async (
  root: string
): Promise<MintlifyMigrationResult> => {
  const warnings: string[] = [];
  const configFile = existsSync(join(root, "docs.json"))
    ? join(root, "docs.json")
    : join(root, "mint.json");

  let config: BlumeConfig;
  if (existsSync(configFile)) {
    config = await loadMintlifyConfig(root, configFile);
    const spec = JSON.parse(await readFile(configFile, "utf-8")) as Record<
      string,
      unknown
    >;
    const i18n = mintlifyI18n(spec);
    if (i18n) {
      config.i18n = i18n;
      // Language switching is handled by Blume i18n, not a nav selector.
      if (config.navigation?.selectors) {
        config.navigation.selectors = config.navigation.selectors.filter(
          (selector) => selector.kind !== "language"
        );
      }
      warnings.push(
        `Mapped ${i18n.locales.length} languages to i18n.locales (default: ${i18n.defaultLocale}); review the locale labels.`
      );
    }
    const openapiSources = config.openapi?.sources ?? [];
    if (openapiSources.length > 0) {
      warnings.push(
        `Mapped ${openapiSources.length} OpenAPI spec source(s) to openapi.sources (native reference renderer); verify each spec path or URL resolves.`
      );
    }
    warnings.push(...droppedChromeWarnings(spec, config));
    warnings.push(...droppedRedirectWarnings(spec));
  } else {
    warnings.push("No docs.json or mint.json found; writing a default config.");
    config = { content: { root: "." }, title: "Documentation" };
  }

  const variables = (config.variables as Record<string, string>) ?? {};
  // Globals are inlined into content below; Blume has no runtime substitution.
  config.variables = undefined;

  const files = await glob(["**/*.{md,mdx}"], {
    absolute: true,
    cwd: root,
    ignore: [
      "node_modules/**",
      ".blume/**",
      "dist/**",
      "public/**",
      "snippets/**",
    ],
  });

  let moved = 0;
  const removedKeys = new Set<string>();
  const unsupported = new Set<string>();
  const keptComponents = new Set<string>();
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- sequential fs writes
    const raw = await readFile(file, "utf-8");
    // oxlint-disable-next-line no-await-in-loop -- sequential transforms
    const result = await transformMintlifyContent(raw, {
      filePath: file,
      root,
      variables,
    });
    if (result.content !== raw) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fs writes
      await mkdir(dirname(file), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop -- sequential fs writes
      await writeFile(file, result.content, "utf-8");
    }
    for (const key of result.removed) {
      removedKeys.add(key);
    }
    for (const name of result.unsupported) {
      unsupported.add(name);
    }
    for (const name of result.components) {
      keptComponents.add(name);
    }
    moved += 1;
  }

  const assets = await relocateAssets(root, assetSegments(config));
  await cleanupSnippets(root, keptComponents, warnings);

  if (config.content?.exclude) {
    config.content.exclude = [...new Set(config.content.exclude)];
  }
  applyRelocatedAssets(config, assets, warnings);
  await writeBlumeConfig(root, config);
  // Drop the source config only after the Blume config is safely on disk, so a
  // mid-migration failure never leaves the project with neither.
  await removeForeignConfig(root, warnings);
  await scaffoldProjectFiles(root, warnings);

  if (Object.keys(variables).length > 0) {
    warnings.push(
      `Inlined ${Object.keys(variables).length} docs.json variable(s) into content; Blume has no runtime variable substitution.`
    );
  }
  if (removedKeys.size > 0) {
    warnings.push(
      `Dropped unsupported page frontmatter keys: ${[...removedKeys].join(", ")}.`
    );
  }
  if (unsupported.size > 0) {
    warnings.push(
      `Components without a Blume equivalent need manual review: ${[...unsupported].join(", ")}.`
    );
  }
  warnings.push(
    "Review blume.config.ts; navigation, theme, and chrome were mapped from docs.json."
  );

  return { moved, warnings };
};
