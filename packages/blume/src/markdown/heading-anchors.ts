/**
 * Turn every section heading into its own permalink. A Satteri hast plugin runs
 * after Markdown is turned into hast and wraps each `<h2>`–`<h6>`'s content in an
 * `<a href="#slug">`, so a reader can click the heading to copy, bookmark, or
 * share a link straight to that section. `<h1>` (the page title) is slugged for
 * parity but left unwrapped.
 *
 * Satteri's own `heading-ids` plugin (which assigns the `id` used by the table
 * of contents) runs *after* every user hast plugin, and it reuses an `id` that
 * is already present rather than re-slugging. So this plugin is the authoritative
 * id setter: it slugs each heading with the same algorithm (a per-document
 * `github-slugger`, the library Satteri and rehype-slug both use) and writes the
 * `id`, which `heading-ids` then adopts — keeping the in-page anchor, the
 * heading's `id`, and the TOC entry in lockstep. To match Satteri's duplicate
 * disambiguation (`setup`, `setup-1`, …) exactly, it advances the slugger over
 * `<h1>`–`<h6>` in document order even though only `<h2>`–`<h6>` get wrapped.
 */

import { satteriCollectHastText } from "@astrojs/markdown-satteri";
import GithubSlugger from "github-slugger";

/** A minimal hast node (avoids a hast type dependency). */
interface HastNode {
  children?: HastNode[];
  name?: string;
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

/** The slice of Satteri's hast visitor context this plugin reads. */
interface HastContext {
  data?: { astro?: { frontmatter?: Record<string, unknown> } };
  setProperty: (node: HastNode, key: string, value: unknown) => void;
  textContent: (node: HastNode) => string;
}

/** A Satteri hast plugin, typed structurally to avoid a Satteri dep. */
export interface HeadingAnchorPlugin {
  name: string;
  element: {
    filter: string[];
    visit: (node: HastNode, ctx: HastContext) => HastNode | undefined;
  };
}

/** Headings slugged for id parity with Satteri; only a subset gets wrapped. */
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const WRAPPED = new Set(["h2", "h3", "h4", "h5", "h6"]);

/** True if the subtree already contains an `<a>`, so wrapping would nest links. */
const containsAnchor = (node: HastNode): boolean => {
  for (const child of node.children ?? []) {
    if ((child.tagName ?? child.name) === "a" || containsAnchor(child)) {
      return true;
    }
  }
  return false;
};

// One slugger per document render. The plugin instance is shared across every
// page, but slug disambiguation must reset per document; the render-scoped
// `astro` data object is a stable, unique key for one render (entries are
// dropped once the render is collected, so this never leaks).
const FALLBACK_SCOPE: object = {};
const sluggers = new WeakMap<object, GithubSlugger>();

const sluggerFor = (ctx: HastContext): GithubSlugger => {
  const scope = ctx.data?.astro ?? ctx.data ?? FALLBACK_SCOPE;
  const existing = sluggers.get(scope);
  if (existing) {
    return existing;
  }
  const slugger = new GithubSlugger();
  sluggers.set(scope, slugger);
  return slugger;
};

/** The slug for a heading, mirroring Satteri's `heading-ids` exactly. */
const slugFor = (
  node: HastNode,
  ctx: HastContext,
  slugger: GithubSlugger
): string => {
  const rawText = ctx.textContent(node);
  // `frontmatter`-interpolated MDX headings (`## {frontmatter.title}`) need the
  // resolved value; the helper is the same one `heading-ids` defers to.
  const text = rawText.includes("frontmatter")
    ? satteriCollectHastText(
        node as Parameters<typeof satteriCollectHastText>[0],
        ctx.data?.astro?.frontmatter ?? {}
      )
    : rawText;
  const existingId = node.properties?.id;
  return typeof existingId === "string" ? existingId : slugger.slug(text);
};

/** Build the plugin. Wraps `<h2>`–`<h6>` in self-linking anchors. */
export const headingAnchorPlugin = (): HeadingAnchorPlugin => ({
  element: {
    filter: HEADINGS,
    visit(node, ctx) {
      const slug = slugFor(node, ctx, sluggerFor(ctx));
      const wrap = node.tagName
        ? WRAPPED.has(node.tagName) && slug !== "" && !containsAnchor(node)
        : false;
      if (!wrap) {
        // Unwrapped headings (h1, an empty slug, or one that already links) still
        // need the id so `heading-ids` adopts it instead of re-slugging.
        if (typeof node.properties?.id !== "string") {
          ctx.setProperty(node, "id", slug);
        }
        return;
      }
      // Replacing the heading re-emits its original children as refs inside the
      // new anchor (Satteri passes reused nodes through untouched).
      return {
        children: [
          {
            children: node.children ?? [],
            properties: {
              className: ["blume-heading-anchor"],
              href: `#${slug}`,
            },
            tagName: "a",
            type: "element",
          },
        ],
        properties: { ...node.properties, id: slug },
        tagName: node.tagName,
        type: "element",
      };
    },
  },
  name: "blume:heading-anchors",
});
