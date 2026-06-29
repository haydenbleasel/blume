import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, join } from "pathe";
import { glob } from "tinyglobby";

import type { BlumeConfig } from "../../core/schema.ts";
import { loadMintlifyConfig } from "./config.ts";
import {
  rewriteMintlifyCallouts,
  rewriteMintlifyExampleBlocks,
  rewriteSnippetImports,
  unsupportedMintlifyComponents,
} from "./content.ts";
import {
  normalizeMintlifyPageMeta,
  stripUnknownPageMeta,
} from "./frontmatter.ts";
import { mintlifyI18n } from "./i18n.ts";
import { rewriteMintlifySvgIconProps } from "./icons.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
  rewriteMintlifyUserVariable,
} from "./snippets.ts";

export interface MintlifyMigrationResult {
  moved: number;
  warnings: string[];
}

const USER_REFERENCE = /\{[^{}]*\buser\b/u;

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

/** Apply the per-file source transforms that turn Mintlify MDX into Blume MDX. */
const transformContent = async (
  raw: string,
  options: { filePath: string; root: string; variables: Record<string, string> }
): Promise<{
  components: string[];
  content: string;
  removed: string[];
  unsupported: string[];
}> => {
  let text = await rewriteMintlifyMarkdownSnippets(raw, {
    filePath: options.filePath,
    root: options.root,
  });
  text = await rewriteMintlifySnippetVariables(text, {
    filePath: options.filePath,
    root: options.root,
  });
  text = rewriteMintlifyGlobalVariables(text, options.variables);
  if (USER_REFERENCE.test(text)) {
    text = rewriteMintlifyUserVariable(text);
  }
  const snippetImports = rewriteSnippetImports(text, {
    filePath: options.filePath,
    root: options.root,
  });
  text = snippetImports.source;
  text = rewriteMintlifySvgIconProps(text);
  text = rewriteMintlifyExampleBlocks(text);
  text = rewriteMintlifyCallouts(text);

  const unsupported = unsupportedMintlifyComponents(text);

  const parsed = matter(text);
  const mapped = normalizeMintlifyPageMeta(parsed.data);
  const { data, removed } = stripUnknownPageMeta(mapped);
  const content =
    Object.keys(data).length > 0
      ? matter.stringify(parsed.content, data)
      : parsed.content;

  return {
    components: snippetImports.components,
    content,
    removed,
    unsupported,
  };
};

/** Move a referenced top-level asset path (file or dir) under `public/`. */
const relocateAssets = async (
  root: string,
  refs: unknown[]
): Promise<string[]> => {
  const segments = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== "string" || !ref.startsWith("/")) {
      continue;
    }
    const [segment] = ref.replace(/^\/+/u, "").split("/");
    if (segment) {
      segments.add(segment);
    }
  }

  const moved: string[] = [];
  for (const segment of segments) {
    const source = join(root, segment);
    if (!existsSync(source) || segment === "public") {
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
  return moved;
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

/** Asset paths referenced by the resolved config (logo, favicon, backgrounds). */
const assetRefs = (config: BlumeConfig): unknown[] => {
  const refs: unknown[] = ["/images"];
  const logo = config.logo as
    | string
    | { dark?: string; light?: string }
    | undefined;
  if (typeof logo === "string") {
    refs.push(logo);
  } else if (logo) {
    refs.push(logo.light, logo.dark);
  }
  const favicon = config.favicon as
    | string
    | { dark?: string; light?: string }
    | undefined;
  if (typeof favicon === "string") {
    refs.push(favicon);
  } else if (favicon) {
    refs.push(favicon.light, favicon.dark);
  }
  refs.push(config.theme?.backgroundImage, config.theme?.backgroundImageDark);
  return refs;
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
    const result = await transformContent(raw, {
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

  const movedAssets = await relocateAssets(root, assetRefs(config));
  await cleanupSnippets(root, keptComponents, warnings);

  if (config.content?.exclude) {
    config.content.exclude = [...new Set(config.content.exclude)];
  }
  await writeBlumeConfig(root, config);

  if (Object.keys(variables).length > 0) {
    warnings.push(
      `Inlined ${Object.keys(variables).length} docs.json variable(s) into content; Blume has no runtime variable substitution.`
    );
  }
  if (movedAssets.length > 0) {
    warnings.push(`Moved assets into public/: ${movedAssets.join(", ")}.`);
  }
  if (removedKeys.size > 0) {
    warnings.push(
      `Dropped unsupported page frontmatter keys: ${[...removedKeys].join(", ")}.`
    );
  }
  if (unsupported.size > 0) {
    warnings.push(
      `Components without a Blume equivalent need manual review (use the OpenAPI reference instead): ${[...unsupported].join(", ")}.`
    );
  }
  warnings.push(
    "Review blume.config.ts; navigation, theme, and chrome were mapped from docs.json."
  );

  return { moved, warnings };
};
