import { parse } from "node-html-parser";
import type { HTMLElement } from "node-html-parser";

/**
 * A parsed HTML document. Re-exported so the rest of the audit types against
 * this module rather than the parser: `node-html-parser` is deliberately
 * quarantined here, so swapping it stays a one-file change.
 */
export type HtmlDocument = HTMLElement;

/**
 * Parse built HTML into a queryable tree.
 *
 * `blockTextElements` keeps the raw text of `<script>`/`<style>`/`<pre>` intact
 * instead of parsing it as markup — the audit reads `<script
 * type="application/ld+json">` bodies verbatim to validate structured data.
 */
export const parseHtml = (html: string): HtmlDocument =>
  parse(html, {
    blockTextElements: { noscript: true, pre: true, script: true, style: true },
    comment: false,
  });

/** Trimmed attribute value, or null when absent or empty. */
export const attr = (element: HTMLElement, name: string): string | null => {
  const value = element.getAttribute(name)?.trim();
  return value || null;
};

/** `content` of every `<meta>` matching a selector, in document order. */
export const metaContents = (
  document: HtmlDocument,
  selector: string
): string[] =>
  document
    .querySelectorAll(selector)
    .map((element) => element.getAttribute("content")?.trim() ?? "")
    .filter((value) => value.length > 0);

/**
 * Collapse an element's visible text. Script/style bodies and code blocks are
 * dropped: a fenced code sample isn't prose, and counting it would let a page
 * that is 90% code pass the word-count check on the strength of its snippets.
 */
export const visibleText = (element: HTMLElement): string => {
  const clone = parse(element.outerHTML, {
    blockTextElements: { noscript: true, pre: true, script: true, style: true },
    comment: false,
  });
  for (const node of clone.querySelectorAll("script, style, pre, code")) {
    node.remove();
  }
  return clone.structuredText.replaceAll(/\s+/gu, " ").trim();
};
