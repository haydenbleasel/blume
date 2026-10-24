import {
  isInternalPath,
  withAuthoredBasePath,
  withBasePath,
} from "../core/base-path.ts";
import { servesRoute } from "../core/locale-links.ts";
import { rewriteElementUrls } from "../core/sources/normalize.ts";
import type { MdastNode, MdastValue } from "./mdast.ts";
import { routeSnapshotReader } from "./route-snapshot.ts";

interface UrlNode extends MdastNode {
  url?: string | null;
}

/** Raw HTML in a `.md` page. */
interface HtmlNode extends MdastNode {
  value: string;
}

/** An MDX JSX attribute, as the plugin reads it. */
interface JsxAttribute {
  [key: string]: MdastValue;
  name?: string;
  type?: string;
  value?: MdastValue;
}

/** An MDX JSX element (`<a href="/guide">`), as the plugin reads it. */
interface JsxNode extends MdastNode {
  attributes?: JsxAttribute[];
  children?: MdastValue[];
  name?: string | null;
}

/**
 * The slice of Satteri's MDAST visitor context this plugin needs. Nodes are
 * read-only (the tree compiles to an op-stream), so a URL edit is recorded via
 * `setProperty`, not by mutating the node object.
 */
interface MdastUrlContext {
  replaceNode: (node: MdastNode, replacement: MdastNode) => void;
  setProperty: (node: MdastNode, key: "url" | "value", value: string) => void;
}

/** An HTML element's name, as opposed to a component's (`Card`). */
const HTML_ELEMENT = /^[a-z]/u;

/** A plain string attribute value; an expression value isn't a URL. */
const isStringValue = (value: MdastValue): value is string =>
  typeof value === "string";

/** Only a string URL can be rebased; MDAST allows null or absent urls. */
const isUrl = (url: string | null | undefined): url is string =>
  typeof url === "string";

/** Record `based(url)` on the node when its root-relative URL changes. */
const rebase = (
  node: UrlNode,
  ctx: MdastUrlContext,
  based: (url: string) => string
): void => {
  const { url } = node;
  if (isUrl(url) && isInternalPath(url)) {
    const next = based(url);
    if (next !== url) {
      ctx.setProperty(node, "url", next);
    }
  }
};

export interface BaseLinksPluginOptions {
  /**
   * The `blume:data` JSON file, for an ejected app: with no CLI in the process
   * to publish the snapshot, the plugin reads the file eject writes instead.
   */
  dataFile?: string;
}

/**
 * Satteri MDAST plugin that prepends the served-URL base to root-relative
 * internal links, so authors write links as if mounted at root. A page link
 * gains `deployment.base` layered over the site-wide `basePath` (`[x](/guide)`
 * -> `/base/docs/guide`); a public asset — an image, or a link to a file like
 * `/spec.pdf` (see `withAuthoredBasePath`) — gains `deployment.base` alone,
 * since Astro serves `public/` under it but never under `basePath`. A raw
 * HTML element's `href` or `src` (`<a href="/guide">`, `<img src="/x.png">`,
 * in a `.md` page or as an `.mdx` element) gains `deployment.base` alone: the
 * whole site moves under it, but a raw `href` keeps no `basePath`, as
 * `blume validate` reads it. Idempotent per layer (a hand-written `/docs/x`
 * isn't double-prefixed) and inert for external URLs, fragments, and
 * relative paths. Only constructed when a base is set (see
 * `markdown/index.ts`).
 */
export const baseLinksPlugin = (
  deployBase: string,
  basePath: string,
  options: BaseLinksPluginOptions = {}
) => {
  const readSnapshot = routeSnapshotReader(options.dataFile);
  // Parsed once per published snapshot, like the relative-links index.
  let cached: { routes: Set<string>; text: string } | undefined;

  /** Every route the site serves (base-prefixed), from the route snapshot. */
  const servedRoutes = (): ReadonlySet<string> => {
    const text = readSnapshot();
    if (text === undefined) {
      return new Set();
    }
    if (cached?.text !== text) {
      const data: { routes: { path: string }[] } = JSON.parse(text);
      cached = {
        routes: new Set(data.routes.map((route) => route.path)),
        text,
      };
    }
    return cached.routes;
  };

  /** Whether a page is served at a based, fragment-less path. */
  const servesPage = (route: string): boolean =>
    servesRoute(servedRoutes(), route);

  const rebaseLink = (node: UrlNode, ctx: MdastUrlContext): void =>
    rebase(node, ctx, (url) =>
      withAuthoredBasePath(deployBase, basePath, url, servesPage)
    );
  // An image is always a file, never a page: `public/` (or a generated asset
  // endpoint), served under the deployment base but not `basePath`.
  const rebaseImage = (node: UrlNode, ctx: MdastUrlContext): void =>
    rebase(node, ctx, (url) => withBasePath(deployBase, url));

  /** A raw element's root-relative URL under the deployment base, if it moves. */
  const based = (url: string): string | null => {
    const next = withBasePath(deployBase, url);
    return next === url ? null : next;
  };

  const rebaseHtml = (node: HtmlNode, ctx: MdastUrlContext): void => {
    // An HTML node's value is raw HTML: it holds no Markdown code, and a
    // comment in it renders nothing whether it's rewritten or not.
    const next = rewriteElementUrls(
      node.value,
      ({ value }) => based(value),
      null
    );
    if (next !== node.value) {
      ctx.setProperty(node, "value", next);
    }
  };

  const rebaseElement = (node: JsxNode, ctx: MdastUrlContext): void => {
    if (!(node.name && HTML_ELEMENT.test(node.name))) {
      return;
    }
    let changed = false;
    const attributes = (node.attributes ?? []).map((attribute) => {
      const { name, value } = attribute;
      const next =
        attribute.type === "mdxJsxAttribute" &&
        (name === "href" || name === "src") &&
        isStringValue(value)
          ? based(value)
          : null;
      if (next === null) {
        return attribute;
      }
      changed = true;
      return { name, type: attribute.type, value: next };
    });
    if (changed) {
      // Sätteri can't set a JSX element's attributes in place, so the element
      // is swapped for a copy; its children carry over and are still visited.
      ctx.replaceNode(node, {
        attributes,
        children: node.children ?? [],
        name: node.name,
        type: node.type,
      });
    }
  };

  // `link` covers inline links; `definition` covers reference-style
  // definitions (`[x]: /guide`), which a link or an image may cite.
  return {
    definition: rebaseLink,
    html: rebaseHtml,
    image: rebaseImage,
    link: rebaseLink,
    mdxJsxFlowElement: rebaseElement,
    mdxJsxTextElement: rebaseElement,
    name: "blume-base-links",
  };
};
