import type { MdastNode, MdastValue } from "./mdast.ts";

/**
 * A page's questions and answers, for its `FAQPage` JSON-LD node. A page
 * opts in with front matter `seo.faq: true`; each `##` heading that ends in
 * a question mark is then a question, and the plain text up to the next `##`
 * heading is its answer. The plugin reads them off the tree and hands them to
 * the page template through the render's frontmatter, as `views.ts` does its
 * views, and the layout adds the node (see `seo/jsonld.ts`).
 */

/** The render-frontmatter key the page's questions travel on. */
export const FAQ_KEY = "blumeFaq";

/** One question and its accepted answer, as plain text. */
export interface FaqEntry {
  answer: string;
  question: string;
}

/** The root, as the plugin's `after` hook receives it. */
interface FaqRoot {
  children: MdastNode[];
}

/** The slice of Satteri's visitor context the plugin uses. */
export interface FaqContext {
  data?: { astro?: { frontmatter?: Record<string, MdastValue> } };
}

/** Blocks whose text isn't part of an answer: code, raw markup, ESM. */
const SKIPPED = new Set(["code", "html", "mdxjsEsm", "mdxFlowExpression"]);

const isNode = (value: MdastValue): value is MdastNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: MdastValue): value is string =>
  typeof value === "string";

/** A node's plain text: its text and inline code, block by block. */
const plainText = (node: MdastNode): string => {
  if (SKIPPED.has(node.type)) {
    return "";
  }
  if (
    (node.type === "text" || node.type === "inlineCode") &&
    isText(node.value)
  ) {
    return node.value;
  }
  const children = Array.isArray(node.children)
    ? node.children.filter(isNode)
    : [];
  return children.map(plainText).join(node.type === "list" ? " " : "");
};

/** Whitespace collapsed to single spaces. */
const squash = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

/** The page's questions, in order; an unanswered one is dropped. */
export const pageFaq = (nodes: readonly MdastNode[]): FaqEntry[] => {
  const entries: FaqEntry[] = [];
  let current: { blocks: string[]; question: string } | null = null;
  const close = (): void => {
    const answer = current ? squash(current.blocks.join(" ")) : "";
    if (current && answer) {
      entries.push({ answer, question: current.question });
    }
    current = null;
  };
  for (const node of nodes) {
    if (node.type === "heading" && node.depth === 2) {
      close();
      const question = squash(plainText(node));
      current = question.endsWith("?") ? { blocks: [], question } : null;
    } else if (current) {
      current.blocks.push(plainText(node));
    }
  }
  close();
  return entries;
};

/** Whether the page's front matter turns its FAQ on (`seo.faq: true`). */
const wantsFaq = (frontmatter: Record<string, MdastValue>): boolean => {
  const { seo } = frontmatter;
  return isNode(seo) && seo.faq === true;
};

export const faqPlugin = () => ({
  after(root: FaqRoot, ctx: FaqContext) {
    const frontmatter = ctx.data?.astro?.frontmatter;
    if (!(frontmatter && wantsFaq(frontmatter))) {
      return;
    }
    const entries = pageFaq(root.children);
    if (entries.length > 0) {
      frontmatter[FAQ_KEY] = entries.map((entry) => ({ ...entry }));
    }
  },
  name: "blume-faq",
});
