import {
  isInternalPath,
  withAuthoredBasePath,
  withBasePath,
} from "../core/base-path.ts";
import { servesRoute } from "../core/locale-links.ts";
import type { MdastNode } from "./mdast.ts";
import { routeSnapshotReader } from "./route-snapshot.ts";

interface UrlNode extends MdastNode {
  url?: string | null;
}

/**
 * The slice of Satteri's MDAST visitor context this plugin needs. Nodes are
 * read-only (the tree compiles to an op-stream), so a URL edit is recorded via
 * `setProperty`, not by mutating the node object.
 */
interface MdastUrlContext {
  setProperty: (node: MdastNode, key: "url", value: string) => void;
}

/** Only a string URL can be rebased; MDAST allows null or absent urls. */
const isUrl = (url: string | null | undefined): url is string =>
  typeof url === "string";

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
 * since Astro serves `public/` under it but never under `basePath`.
 * Idempotent per layer (a hand-written `/docs/x` isn't double-prefixed) and
 * inert for external URLs, fragments, and relative paths. Only constructed
 * when a base is set (see `markdown/index.ts`).
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
  const rebaseLink = (node: UrlNode, ctx: MdastUrlContext): void =>
    rebase(node, ctx, (url) =>
      withAuthoredBasePath(deployBase, basePath, url, servesPage)
    );
  // An image is always a file, never a page: `public/` (or a generated asset
  // endpoint), served under the deployment base but not `basePath`.
  const rebaseImage = (node: UrlNode, ctx: MdastUrlContext): void =>
    rebase(node, ctx, (url) => withBasePath(deployBase, url));
  // `link` covers inline links; `definition` covers reference-style
  // definitions (`[x]: /guide`), which a link or an image may cite.
  return {
    definition: rebaseLink,
    image: rebaseImage,
    link: rebaseLink,
    name: "blume-base-links",
  };
};
