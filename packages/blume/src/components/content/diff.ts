/**
 * Build-time diff rendering for `<Diff>`.
 *
 * Produces a self-contained HTML string with [`@pierre/diffs`](https://diffs.com)
 * via its `./ssr` entry — no DOM, no React, no client JS. The returned markup
 * carries its own `:host` stylesheet and is meant to be placed inside a
 * declarative shadow root (see `Diff.astro`). Three input shapes are supported:
 * a unified patch (string or `.patch`/`.diff` file), a pair of file paths, or a
 * pair of inline strings.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { registerCustomTheme } from "@pierre/diffs";
import { preloadDiffHTML, preloadPatchDiff } from "@pierre/diffs/ssr";
import { isAbsolute, join } from "pathe";

import { DEFAULT_CODE_THEMES } from "../../markdown/themes.ts";
import type { CodeTheme, CodeThemes } from "../../markdown/themes.ts";

export interface DiffOptions {
  /** Path to the "after" file, resolved relative to {@link DiffOptions.root}. */
  after?: string;
  /** Path to the "before" file, resolved relative to {@link DiffOptions.root}. */
  before?: string;
  /** Language for inline {@link DiffOptions.old}/{@link DiffOptions.new} input. */
  lang?: string;
  /** The "after" contents, as an inline string. Pairs with {@link DiffOptions.old}. */
  new?: string;
  /** The "before" contents, as an inline string. Pairs with {@link DiffOptions.new}. */
  old?: string;
  /** A unified diff/patch as an inline string. */
  patch?: string;
  /** Base directory for resolving relative paths. Defaults to `process.cwd()`. */
  root?: string;
  /** Path to a `.patch`/`.diff` file, resolved relative to {@link DiffOptions.root}. */
  src?: string;
  /**
   * Light/dark Shiki themes (`markdown.codeBlocks.theme`). Defaults to the same
   * github pair Blume's code blocks use, keeping diffs in lockstep.
   */
  theme?: CodeThemes;
}

const resolvePath = (path: string, root: string): string =>
  isAbsolute(path) ? path : join(root, path);

const readText = (path: string, root: string): Promise<string> =>
  readFile(resolvePath(path, root), "utf-8");

const registeredDiffThemes = new WeakMap<object, Map<string, string>>();

/**
 * Pierre accepts custom Shiki themes through its registry, while Shiki itself
 * accepts the object directly. Register each configured object under a name
 * derived from its content and resolved type, so registration survives
 * dev-server reloads: the same theme re-registers under the same name (a
 * harmless collision in Pierre's registry, which keeps the identical loader),
 * while an edited theme gets a fresh name instead of a stale entry. The memo
 * is keyed per resolved type as well — a typeless object shared between both
 * modes must not hand light mode the dark-typed registration.
 */
const diffThemeName = (theme: CodeTheme, mode: "dark" | "light"): string => {
  if (typeof theme === "string") {
    return theme;
  }
  const type = theme.type ?? mode;
  let byType = registeredDiffThemes.get(theme);
  if (!byType) {
    byType = new Map();
    registeredDiffThemes.set(theme, byType);
  }
  const cached = byType.get(type);
  if (cached) {
    return cached;
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(theme))
    .digest("hex")
    .slice(0, 12);
  const name = `blume-custom-${hash}-${type}`;
  const registered = { ...theme, name, type };
  registerCustomTheme(name, () => Promise.resolve(registered));
  byType.set(type, name);
  return name;
};

const diffThemes = (themes: CodeThemes): { dark: string; light: string } => ({
  dark: diffThemeName(themes.dark, "dark"),
  light: diffThemeName(themes.light, "light"),
});

/**
 * Resolve `<Diff>` inputs to a prerendered HTML string. Throws when no input
 * group is supplied or a pair is half-specified, so the component can degrade
 * to an inline notice.
 */
export const renderDiff = async (options: DiffOptions): Promise<string> => {
  const {
    after,
    before,
    lang,
    new: newText,
    old,
    patch,
    root = process.cwd(),
    src,
    theme = DEFAULT_CODE_THEMES,
  } = options;

  if (patch !== undefined || src !== undefined) {
    const text = patch ?? (await readText(src as string, root));
    const result = await preloadPatchDiff({
      options: { theme: diffThemes(theme) },
      patch: text,
    });
    return result.prerenderedHTML;
  }

  if (before !== undefined || after !== undefined) {
    if (before === undefined || after === undefined) {
      throw new Error("<Diff> needs both `before` and `after` file paths.");
    }
    return await preloadDiffHTML({
      newFile: { contents: await readText(after, root), name: after },
      oldFile: { contents: await readText(before, root), name: before },
      options: { theme: diffThemes(theme) },
    });
  }

  if (old !== undefined || newText !== undefined) {
    if (old === undefined || newText === undefined) {
      throw new Error("<Diff> needs both `old` and `new` strings.");
    }
    return await preloadDiffHTML({
      newFile: { contents: newText, lang, name: "snippet" },
      oldFile: { contents: old, lang, name: "snippet" },
      options: { disableFileHeader: true, theme: diffThemes(theme) },
    });
  }

  throw new Error(
    "<Diff> requires one input: `patch`/`src`, `before`+`after`, or `old`+`new`."
  );
};
