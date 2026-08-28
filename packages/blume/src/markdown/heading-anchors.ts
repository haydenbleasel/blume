/**
 * Heading ids, trailing markers, and self-linking anchors. A Satteri hast
 * plugin runs after Markdown is turned into hast and, for every heading:
 *
 * - parses trailing markers (`[#custom-id]`, `{#custom-id}`, `[!toc]`, `[toc]`
 *   — see `core/heading-markers.ts`) and strips them from the rendered text;

 * - assigns the anchor `id` (the `[#custom-id]` pin, else a `github-slugger`
 *   slug of the marker-free text);
 * - wraps `<h2>`–`<h6>` content in an `<a href="#slug">` so a reader can click
 *   the heading to copy, bookmark, or share a link straight to that section
 *   (`<h1>` — the page title — is slugged for parity but left unwrapped, and
 *   `wrap: false` turns the anchor links off without losing the markers).
 *
 * Satteri's own `heading-ids` plugin (which assigns the `id` used by the table
 * of contents) runs *after* every user hast plugin, and it reuses an `id` that
 * is already present rather than re-slugging. So this plugin is the
 * authoritative id setter: it slugs each heading with the same algorithm (a
 * per-document `github-slugger`, the library Satteri and rehype-slug both use)
 * and writes the `id`, which `heading-ids` then adopts — keeping the in-page
 * anchor, the heading's `id`, and the TOC entry in lockstep. To match
 * Satteri's duplicate disambiguation (`setup`, `setup-1`, …) exactly, it
 * advances the slugger over `<h1>`–`<h6>` in document order even though only
 * `<h2>`–`<h6>` get wrapped.
 *
 * TOC visibility flows out through the render's frontmatter: the slugs of
 * `[!toc]` headings are pushed onto `frontmatter[TOC_HIDDEN_KEY]`, which Astro
 * surfaces as `remarkPluginFrontmatter` so the page template can filter them
 * out of the headings list. `[toc]` headings render with the
 * `blume-toc-only` class (visually hidden, still a live anchor target) so the
 * TOC entry has somewhere to scroll to.
 */

import { satteriCollectHastText } from "@astrojs/markdown-satteri";
import GithubSlugger from "github-slugger";

import {
  occupySlug,
  parseHeadingMarkers,
  TOC_HIDDEN_KEY,
} from "../core/heading-markers.ts";

/** A hast property value: an attribute primitive or a token list. */
type HastPropertyValue = string | number | boolean | (string | number)[];

/** A minimal hast node (avoids a hast type dependency). */
interface HastNode {
  children?: HastNode[];
  name?: string;
  properties?: Record<string, HastPropertyValue>;
  tagName?: string;
  type: string;
  value?: string;
}

/** The slice of Satteri's hast visitor context this plugin reads. */
interface HastContext {
  data?: {
    astro?: { frontmatter?: Parameters<typeof satteriCollectHastText>[1] };
  };
  setProperty: (node: HastNode, key: string, value: HastPropertyValue) => void;
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

export interface HeadingAnchorOptions {
  /** Wrap `<h2>`–`<h6>` in self-linking anchors (`markdown.headingAnchors`). */
  wrap?: boolean;
}

/** Headings slugged for id parity with Satteri; only a subset gets wrapped. */
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const WRAPPED = new Set(["h2", "h3", "h4", "h5", "h6"]);

/** The class that renders a `[toc]`-only heading as an invisible anchor. */
const TOC_ONLY_CLASS = "blume-toc-only";

/** True if the subtree already contains an `<a>`, so wrapping would nest links. */
const containsAnchor = (node: HastNode): boolean => {
  for (const child of node.children ?? []) {
    if ((child.tagName ?? child.name) === "a" || containsAnchor(child)) {
      return true;
    }
  }
  return false;
};

// One state record per document render. The plugin instance is shared across
// every page, but slug disambiguation (and the hidden-heading list) must reset
// per document; the render-scoped `astro` data object is a stable, unique key
// for one render (entries are dropped once the render is collected, so this
// never leaks).
interface RenderState {
  /** Slugs of `[!toc]` headings, shared by reference with the frontmatter. */
  hidden: string[];
  slugger: GithubSlugger;
}

const FALLBACK_SCOPE = {};
const states = new WeakMap<object, RenderState>();

const stateFor = (ctx: HastContext): RenderState => {
  const scope = ctx.data?.astro ?? ctx.data ?? FALLBACK_SCOPE;
  const existing = states.get(scope);
  if (existing) {
    return existing;
  }
  const state: RenderState = { hidden: [], slugger: new GithubSlugger() };
  states.set(scope, state);
  // Surface the hidden list on the render's frontmatter (Astro's
  // `remarkPluginFrontmatter`) by reference, so slugs pushed later in the
  // document flow through. Assigning a fresh array on state creation also
  // clears a stale list left by a previous render of the same entry.
  const frontmatter = ctx.data?.astro?.frontmatter;
  if (frontmatter) {
    frontmatter[TOC_HIDDEN_KEY] = state.hidden;
  }
  return state;
};

/** Whether a heading already carries a usable string `id`. */
const isStringId = (value: HastPropertyValue | undefined): value is string =>
  typeof value === "string";

/** A parsed heading: marker-free children plus what the markers pinned. */
interface StrippedHeading {
  children: HastNode[];
  id?: string;
  /** Characters the marker strip removed from the heading's text content. */
  strippedLength: number;
  toc?: "hide" | "only";
}

/**
 * Strip trailing markers from a heading's last direct text child. Markers only
 * count at the very end of the heading, so a heading ending in inline code,
 * emphasis, or an expression has no marker position — mirroring the scan-time
 * source scanner, which likewise only matches markers that end the raw line.
 */
const stripMarkers = (node: HastNode): StrippedHeading => {
  const children = node.children ?? [];
  const last = children.at(-1);
  const none = { children, strippedLength: 0 };
  if (last?.type !== "text" || last.value === undefined) {
    return none;
  }
  const markers = parseHeadingMarkers(last.value);
  if (markers.id === undefined && markers.toc === undefined) {
    return none;
  }
  const kept =
    markers.text === ""
      ? children.slice(0, -1)
      : [...children.slice(0, -1), { ...last, value: markers.text }];
  // A heading that is nothing but markers (`## [toc]`) keeps them as literal
  // text: with no heading text left there is nothing to annotate, and
  // stripping would leave an invisible empty element with an empty id and a
  // blank TOC entry. The scan-time scanner and the search extractor mirror
  // this rule.
  if (kept.length === 0) {
    return none;
  }
  return {
    children: kept,
    id: markers.id,
    strippedLength: last.value.length - markers.text.length,
    toc: markers.toc,
  };
};

/** The slug for a heading, mirroring Satteri's `heading-ids` exactly. */
const slugFor = (
  node: HastNode,
  ctx: HastContext,
  slugger: GithubSlugger,
  stripped: StrippedHeading
): string => {
  if (stripped.id !== undefined) {
    // Pinning occupies the id, so a later heading whose auto-slug collides
    // disambiguates (`setup` → `setup-1`) instead of duplicating the anchor.
    occupySlug(slugger, stripped.id);
    return stripped.id;
  }
  const existingId = node.properties?.id;
  if (isStringId(existingId)) {
    return existingId;
  }
  // The marker suffix is a trailing slice of the text content, so the
  // marker-free text is the content minus exactly what the strip removed.
  const fullText = ctx.textContent(node);
  const rawText = stripped.strippedLength
    ? fullText.slice(0, fullText.length - stripped.strippedLength)
    : fullText;
  // `frontmatter`-interpolated MDX headings (`## {frontmatter.title}`) need the
  // resolved value; the helper is the same one `heading-ids` defers to.
  // SAFETY: HastNode is a structural subset of the hast element shape the
  // helper walks (children/type/value), so the node always fits.
  const text = rawText.includes("frontmatter")
    ? satteriCollectHastText(
        {
          ...node,
          children: stripped.children,
        } as Parameters<typeof satteriCollectHastText>[0],
        ctx.data?.astro?.frontmatter ?? {}
      )
    : rawText;
  return slugger.slug(text);
};

/** The heading's class list with `blume-toc-only` appended. */
const withTocOnlyClass = (
  value: HastPropertyValue | undefined
): (string | number)[] => {
  if (Array.isArray(value)) {
    return [...value, TOC_ONLY_CLASS];
  }
  return isStringId(value) && value !== ""
    ? [value, TOC_ONLY_CLASS]
    : [TOC_ONLY_CLASS];
};

/** True if the heading already carries the `[toc]`-only class (a re-visit). */
const hasTocOnlyClass = (node: HastNode): boolean => {
  const value = node.properties?.className;
  return Array.isArray(value)
    ? value.includes(TOC_ONLY_CLASS)
    : value === TOC_ONLY_CLASS;
};

/**
 * Build the plugin. Always parses markers and assigns ids; `wrap: false` only
 * disables the self-linking anchor wrap on `<h2>`–`<h6>`.
 */
export const headingAnchorPlugin = (
  options: HeadingAnchorOptions = {}
): HeadingAnchorPlugin => ({
  element: {
    filter: HEADINGS,
    visit(node, ctx) {
      const state = stateFor(ctx);
      const stripped = stripMarkers(node);
      const slug = slugFor(node, ctx, state.slugger, stripped);
      if (stripped.toc === "hide") {
        state.hidden.push(slug);
      }
      const tocOnly = stripped.toc === "only" || hasTocOnlyClass(node);
      const wrap =
        options.wrap !== false &&
        node.tagName !== undefined &&
        WRAPPED.has(node.tagName) &&
        slug !== "" &&
        !tocOnly &&
        !containsAnchor(node);
      if (!wrap) {
        // Marker-free headings mutate in place; a stripped or `[toc]`-only one
        // needs its children (and class) replaced, so it re-emits as a new
        // element carrying the original children as refs.
        if (stripped.strippedLength || (tocOnly && !hasTocOnlyClass(node))) {
          const properties = tocOnly
            ? {
                ...node.properties,
                className: withTocOnlyClass(node.properties?.className),
                id: slug,
              }
            : { ...node.properties, id: slug };
          return {
            children: stripped.children,
            properties,
            tagName: node.tagName,
            type: "element",
          };
        }
        // Unwrapped headings (h1, an empty slug, or one that already links)
        // still need the id so `heading-ids` adopts it instead of re-slugging.
        if (!isStringId(node.properties?.id)) {
          ctx.setProperty(node, "id", slug);
        }
        return;
      }
      // Replacing the heading re-emits its original children as refs inside the
      // new anchor (Satteri passes reused nodes through untouched).
      return {
        children: [
          {
            children: stripped.children,
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
