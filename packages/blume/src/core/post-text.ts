import type { Nodes } from "mdast";
import { markdownToMdast, mdxToMdast } from "satteri";

import {
  MARKDOWN_BODY_FEATURES,
  MDX_BODY_FEATURES,
} from "../markdown/features.ts";

/**
 * What a blog post's listings read off its body, worked out once at scan
 * time: the first paragraph, which stands in for a missing `description` on
 * the index, in the feed, and in the Markdown mirror, and an estimated
 * reading time for the byline.
 */
export interface PostText {
  /** The body's first paragraph as plain text; absent when it has none. */
  excerpt?: string;
  /** Estimated reading time in whole minutes, at least 1. */
  readingTime: number;
}

/** Words a reader gets through in a minute, the common estimate. */
const WORDS_PER_MINUTE = 200;

/** The longest excerpt, in code points, before it's cut at a word. */
const EXCERPT_MAX = 300;

// Nodes that are never prose a reader reads: image alt text, MDX
// expressions and ESM, math source, raw HTML tags, and front matter.
const SKIPPED = new Set<string>([
  "html",
  "image",
  "imageReference",
  "inlineMath",
  "math",
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxjsEsm",
  "toml",
  "yaml",
]);

const WHITESPACE = /\s+/gu;

// A raw `<br>` tag (Markdown's html node, or MDX's element), which breaks the
// line between two words as a space does.
const LINE_BREAK_TAG = /^<br\b/iu;

const isLineBreak = (node: Nodes): boolean =>
  node.type === "break" ||
  (node.type === "html" && LINE_BREAK_TAG.test(node.value)) ||
  ((node.type === "mdxJsxTextElement" || node.type === "mdxJsxFlowElement") &&
    node.name === "br");

// A `:::name` container directive that the body parser read as a paragraph:
// its markers are syntax, not the post's first words.
const DIRECTIVE = /^:{3,}/u;

const parse = (body: string, format: "md" | "mdx"): Nodes => {
  if (format === "mdx") {
    try {
      return mdxToMdast(body, { features: MDX_BODY_FEATURES });
    } catch {
      // An `.mdx` body the MDX grammar rejects fails to render anyway; read
      // it as Markdown so its listing still gets a reading time.
    }
  }
  return markdownToMdast(body, { features: MARKDOWN_BODY_FEATURES });
};

/**
 * Parents whose children run on in one line of text: a word split across a
 * link or emphasis (`**bold *it*alic**`) stays one word. Every other parent
 * holds blocks, kept apart by a space.
 */
const PHRASING_PARENTS = new Set([
  "delete",
  "emphasis",
  "heading",
  "leafDirective",
  "link",
  "linkReference",
  "mdxJsxTextElement",
  "paragraph",
  "strong",
  "tableCell",
  "textDirective",
]);

/** A node's readable text, words kept apart across block boundaries. */
const textOf = (node: Nodes): string => {
  if (isLineBreak(node)) {
    return " ";
  }
  if (SKIPPED.has(node.type)) {
    return "";
  }
  if ("value" in node) {
    return node.value;
  }
  if ("children" in node) {
    const inline = PHRASING_PARENTS.has(node.type);
    // SAFETY: a parent's children are mdast nodes whatever the parent; the
    // union only types each parent's list apart.
    const children = node.children as Nodes[];
    return children.map(textOf).join(inline ? "" : " ");
  }
  return "";
};

const clean = (text: string): string => text.replaceAll(WHITESPACE, " ").trim();

/** `text` cut at the last word that fits `max` code points, with an ellipsis. */
const clip = (text: string, max: number): string => {
  const chars = [...text];
  if (chars.length <= max) {
    return text;
  }
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
};

/**
 * Words in `text`, by the word segmenter. Its locale is fixed, so a reading
 * time doesn't change with the build machine's.
 */
const countWords = (text: string): number => {
  let words = 0;
  for (const segment of new Intl.Segmenter("en", {
    granularity: "word",
  }).segment(text)) {
    if (segment.isWordLike) {
      words += 1;
    }
  }
  return words;
};

/**
 * A post body's excerpt and reading time. `body` is the page's Markdown or MDX
 * with its front matter already removed, as the scan hands it over.
 */
export const postText = (body: string, format: "md" | "mdx"): PostText => {
  const tree = parse(body, format);
  const children: Nodes[] = "children" in tree ? tree.children : [];
  const excerpt = children
    .filter((node) => node.type === "paragraph")
    .map((node) => clean(textOf(node)))
    .find((text) => text !== "" && !DIRECTIVE.test(text));
  const minutes = Math.round(countWords(textOf(tree)) / WORDS_PER_MINUTE);
  const text: PostText = { readingTime: Math.max(1, minutes) };
  if (excerpt) {
    text.excerpt = clip(excerpt, EXCERPT_MAX);
  }
  return text;
};
