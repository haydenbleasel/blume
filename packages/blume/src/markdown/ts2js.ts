/**
 * Satteri MDAST plugin that turns a TypeScript fence carrying the `ts2js`
 * meta keyword (```ts ts2js) into a `<Tabs>` group with the original
 * TypeScript and an auto-generated JavaScript variant, so authors maintain
 * one snippet and readers pick their dialect. Tab sync is on by default, so
 * every TypeScript/JavaScript group on a page switches together.
 *
 * Types are stripped with Sucrase rather than the TypeScript compiler:
 * `ts.transpileModule` re-prints the file (collapsed blank lines, four-space
 * indentation, a `"use strict"` prologue on import-less snippets), while
 * Sucrase erases type syntax token-by-token and leaves the author's
 * formatting — including comments, and with them Shiki notation markers like
 * `// [!code highlight]` — intact. Erased type-only statements leave blank
 * lines and an erased trailing `as const`/`satisfies` leaves a space before
 * its semicolon; {@link tidy} cleans both up.
 */

import { createRequire } from "node:module";

import type { transform } from "sucrase";

import { codeBlock, jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface CodeNode extends MdastNode {
  lang?: string | null;
  meta?: string | null;
  value: string;
}

/**
 * One fence-meta token: a quoted `key="..."` attribute (spaces allowed inside
 * the quotes) or a bare word, so a keyword inside a quoted value
 * (`title="enable ts2js later"`) never reads as a trigger.
 */
const META_TOKEN = /[\w-]+=(?:"[^"]*"|'[^']*')|\S+/gu;

const metaTokens = (meta: string | null | undefined): string[] =>
  meta?.match(META_TOKEN) ?? [];

/** Re-join filtered meta tokens, or `null` when nothing survives. */
const joinMeta = (tokens: string[]): string | null =>
  tokens.length > 0 ? tokens.join(" ") : null;

const require = createRequire(import.meta.url);

interface Sucrase {
  transform: typeof transform;
}

// Resolved lazily on the first triggered fence, so importing this module (at
// Astro config load) never pays Sucrase's parse cost for ts2js-free sites.
let sucrase: Sucrase | undefined;

/**
 * Clean up Sucrase's erasure artifacts: statements it removes wholesale
 * (interfaces, type aliases) leave runs of blank lines, and a removed
 * trailing type operator leaves a space before the semicolon. Line-anchored
 * regexes could in principle touch a multi-line template literal's interior,
 * but the worst case is cosmetic whitespace in a displayed snippet.
 */
const tidy = (code: string): string =>
  code
    .replaceAll(/[ \t]+;$/gmu, ";")
    .replaceAll(/[ \t]+$/gmu, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

const stripTypes = (code: string, lang: string): string | undefined => {
  // SAFETY: this resolves Blume's own `sucrase` dependency, whose CJS entry
  // exports the `transform` function the interface describes.
  sucrase ??= require("sucrase") as Sucrase;
  try {
    return tidy(
      sucrase.transform(code, {
        // Keep modern syntax (no downleveling) and the authored JSX.
        disableESTransforms: true,
        jsxRuntime: "preserve",
        // The `jsx` transform only for `tsx`: with it enabled, a `ts` angle-
        // bracket assertion (`<number>value`) would parse as JSX and fail.
        transforms: lang === "tsx" ? ["typescript", "jsx"] : ["typescript"],
      }).code
    );
  } catch {
    // Sucrase throws on code it can't parse (pseudocode, deliberate
    // fragments). Render the fence as authored instead of failing the build.
    return undefined;
  }
};

/** Build the `<Tab>` holding one dialect's code fence. */
const tabNode = (
  title: string,
  lang: string,
  value: string,
  meta: string | null
) =>
  jsxFlowElement(
    "Tab",
    [jsxAttribute("title", title)],
    [codeBlock(lang, value, meta)]
  );

/**
 * The `ts2js` fence plugin. The generated JavaScript tab drops `{1,3-5}` line
 * ranges from its meta (line numbers shift once types are gone) but keeps the
 * rest (`title="..."`, `lineNumbers`); the TypeScript tab keeps everything.
 * The keyword itself is stripped from both, which also guarantees the emitted
 * fences can never re-trigger the plugin. Fences that also carry `twoslash`
 * are left alone — hover data can't carry over to the generated JavaScript.
 */
export const ts2jsPlugin = () => ({
  code(node: CodeNode, ctx: MdastVisitorContext) {
    if (node.lang !== "ts" && node.lang !== "tsx") {
      return;
    }
    const tokens = metaTokens(node.meta);
    if (!tokens.includes("ts2js") || tokens.includes("twoslash")) {
      return;
    }
    const jsLang = node.lang === "tsx" ? "jsx" : "js";
    const js = stripTypes(node.value, node.lang);
    // Empty output means a types-only snippet; a blank JavaScript tab helps
    // nobody, so keep the TypeScript fence as-is.
    if (!js) {
      return;
    }
    const kept = tokens.filter((token) => token !== "ts2js");
    const jsMeta = kept.filter((token) => !token.startsWith("{"));
    ctx.replaceNode(
      node,
      jsxFlowElement(
        "Tabs",
        // hash off: picking a dialect must not rewrite the page hash
        // (clobbering the heading anchor the reader arrived with).
        [jsxAttribute("hash", "false")],
        [
          tabNode("TypeScript", node.lang, node.value, joinMeta(kept)),
          tabNode("JavaScript", jsLang, js, joinMeta(jsMeta)),
        ]
      )
    );
  },
  name: "blume-ts2js",
});
