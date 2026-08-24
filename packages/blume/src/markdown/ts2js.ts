/**
 * Satteri MDAST plugin that turns a TypeScript fence carrying the `ts2js`
 * meta keyword (```ts ts2js) into a `<Tabs>` group with the original
 * TypeScript and an auto-generated JavaScript variant, so authors maintain
 * one snippet and readers pick their dialect. The pair carries its own
 * `syncKey`, so every ts2js pair on a page switches together without
 * dragging along authored tab groups that happen to contain a tab titled
 * "JavaScript".
 *
 * Types are stripped with Sucrase rather than the TypeScript compiler:
 * `ts.transpileModule` re-prints the file (collapsed blank lines, four-space
 * indentation, a `"use strict"` prologue on import-less snippets), while
 * Sucrase erases type syntax token-by-token and leaves the author's
 * formatting — and, crucially for {@link tidy}, the line structure — intact.
 */

import { createRequire } from "node:module";

import type { transform } from "sucrase";

import { isLineRange, metaTokens } from "./fence-meta.ts";
import { codeBlock, jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";

interface CodeNode extends MdastNode {
  lang?: string | null;
  meta?: string | null;
  value: string;
}

/** Re-join filtered meta tokens, or `null` when nothing survives. */
const joinMeta = (tokens: string[]): string | null =>
  tokens.length > 0 ? tokens.join(" ") : null;

const require = createRequire(import.meta.url);

interface Sucrase {
  transform: typeof transform;
}

/** How the plugin obtains Sucrase; injectable so tests can fail the load. */
export type SucraseLoader = () => Sucrase;

// SAFETY: this resolves Blume's own `sucrase` dependency, whose CJS entry
// exports the `transform` function the interface describes.
const defaultLoader: SucraseLoader = () => require("sucrase") as Sucrase;

/** Triggering fence languages, mapped to their generated tab's language. */
const JS_LANG = new Map([
  ["ts", "js"],
  ["tsx", "jsx"],
  ["typescript", "js"],
]);

/**
 * Shiki's twoslash transformer triggers on this pattern over the *raw* fence
 * meta (`RE_TWOSLASH` under `explicitTrigger`), so the keyword matches even
 * inside a quoted attribute (`title="the twoslash guide"`). Mirror it
 * exactly: any fence Shiki will twoslash-render is left alone, because hover
 * data can't carry over to the generated JavaScript.
 */
const TWOSLASH = /\btwoslash\b/u;

/** A line holding nothing but a Shiki notation comment (`// [!code …]`). */
const NOTATION_COMMENT = /^\s*\/\/\s*\[!code[^\]]*\]\s*$/u;

/** A line holding nothing but a `//` comment. */
const COMMENT_ONLY = /^\s*\/\//u;

const isBlank = (text: string): boolean => text.trim().length === 0;

interface TidyLine {
  /** The line is blank because erasure removed its code. */
  erased: boolean;
  text: string;
}

/**
 * Clean up Sucrase's erasure artifacts by comparing output to source line by
 * line — erasure never adds or removes lines, so the two align (CRLF input
 * included; the source's line endings are preserved). Untouched lines pass
 * through verbatim, which keeps multi-line template literal interiors —
 * whose blank runs and trailing spaces are string *content* — byte-exact.
 * Lines erasure changed are cleaned:
 *
 * - the stray space a removed trailing type operator leaves before `;` (and
 *   any trailing whitespace) is dropped;
 * - a comment stranded by its erased code — including a trailing Shiki
 *   notation marker (`// [!code highlight]`), which would otherwise
 *   re-anchor to the next line — is removed along with the code it
 *   annotated, as is an own-line notation marker whose target line was
 *   erased;
 * - blank runs erasure created collapse: a run that is entirely erasure
 *   closes up, a run mixing erased and authored blanks keeps a single blank
 *   line, and either is dropped at the snippet's edges.
 */
const tidy = (js: string, source: string): string => {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const srcLines = source.split(/\r?\n/u);
  const srcLine = (index: number): string => srcLines[index] ?? "";
  const lines = js.split(/\r?\n/u).map((line, index): TidyLine => {
    const src = srcLine(index);
    if (line === src) {
      return { erased: false, text: line };
    }
    if (COMMENT_ONLY.test(line) && !COMMENT_ONLY.test(src)) {
      return { erased: true, text: "" };
    }
    const text = line.replace(/[ \t]+;$/u, ";").replace(/[ \t]+$/u, "");
    return { erased: text.length === 0, text };
  });
  // An own-line notation marker anchors to the line below it; if erasure
  // blanked that target, the marker would highlight whatever ends up there
  // instead, so it goes too.
  for (const [index, line] of lines.entries()) {
    const next = lines[index + 1];
    if (
      next &&
      NOTATION_COMMENT.test(line.text) &&
      isBlank(next.text) &&
      !isBlank(srcLine(index + 1))
    ) {
      line.erased = true;
      line.text = "";
    }
  }
  const out: string[] = [];
  let blankRun: TidyLine[] = [];
  let sawCode = false;
  const flushBlanks = (atEnd: boolean) => {
    if (blankRun.some((line) => line.erased)) {
      if (sawCode && !atEnd && blankRun.some((line) => !line.erased)) {
        out.push("");
      }
    } else {
      out.push(...blankRun.map((line) => line.text));
    }
    blankRun = [];
  };
  for (const line of lines) {
    if (isBlank(line.text)) {
      blankRun.push(line);
    } else {
      flushBlanks(false);
      out.push(line.text);
      sawCode = true;
    }
  }
  flushBlanks(true);
  return out.join(eol);
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
 * fences can never re-trigger the plugin.
 *
 * The `loadSucrase` parameter exists for tests; production callers use the
 * default, which resolves Blume's own dependency.
 */
export const ts2jsPlugin = (loadSucrase: SucraseLoader = defaultLoader) => {
  // Resolved lazily on the first triggered fence, so importing this module
  // (at Astro config load) never pays Sucrase's parse cost for ts2js-free
  // sites. `null` records a failed load: every fence degrades to its
  // authored form instead of failing the build, and the load is never
  // retried.
  let sucrase: Sucrase | null | undefined;

  const stripTypes = (code: string, lang: string): string | undefined => {
    if (sucrase === undefined) {
      try {
        sucrase = loadSucrase();
      } catch {
        sucrase = null;
      }
    }
    if (sucrase === null) {
      return undefined;
    }
    try {
      return tidy(
        sucrase.transform(code, {
          // Keep modern syntax (no downleveling) and the authored JSX.
          disableESTransforms: true,
          jsxRuntime: "preserve",
          // An import kept only for the reader's context must survive:
          // without this, Sucrase drops any import with no value-position
          // reference, and the JavaScript tab would show code whose bindings
          // are undefined when copied. Type-only imports (`import type`,
          // `{ type T }`) are still elided.
          keepUnusedImports: true,
          // The `jsx` transform only for `tsx`: with it enabled, a `ts`
          // angle-bracket assertion (`<number>value`) would parse as JSX and
          // fail.
          transforms: lang === "tsx" ? ["typescript", "jsx"] : ["typescript"],
        }).code,
        code
      );
    } catch {
      // Sucrase throws on code it can't parse (pseudocode, deliberate
      // fragments). Render the fence as authored instead of failing the
      // build.
      return undefined;
    }
  };

  return {
    code(node: CodeNode, ctx: MdastVisitorContext) {
      const lang = node.lang ?? "";
      const jsLang = JS_LANG.get(lang);
      if (!jsLang) {
        return;
      }
      const tokens = metaTokens(node.meta);
      if (!tokens.includes("ts2js") || TWOSLASH.test(node.meta ?? "")) {
        return;
      }
      const js = stripTypes(node.value, lang);
      // Empty output means a types-only snippet; a blank JavaScript tab helps
      // nobody, so keep the TypeScript fence as-is.
      if (!js) {
        return;
      }
      const kept = tokens.filter((token) => token !== "ts2js");
      const jsMeta = kept.filter((token) => !isLineRange(token));
      ctx.replaceNode(
        node,
        jsxFlowElement(
          "Tabs",
          [
            // hash off: picking a dialect must not rewrite the page hash
            // (clobbering the heading anchor the reader arrived with).
            jsxAttribute("hash", "false"),
            // Scope syncing to generated pairs: without a key, picking
            // "JavaScript" here would also yank any authored group that has a
            // same-titled tab (an SDK-language switcher, say) — one-way,
            // since "TypeScript" wouldn't match to flip it back.
            jsxAttribute("syncKey", "ts2js"),
          ],
          [
            tabNode("TypeScript", lang, node.value, joinMeta(kept)),
            tabNode("JavaScript", jsLang, js, joinMeta(jsMeta)),
          ]
        )
      );
    },
    name: "blume-ts2js",
  };
};
