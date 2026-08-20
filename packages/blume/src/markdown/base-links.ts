import { isInternalPath, withComposedBasePath } from "../core/base-path.ts";
import type { MdastNode } from "./mdast.ts";

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

/**
 * A path whose final segment carries a file extension (`/spec.pdf`, `/logo.svg`)
 * — treated as a public asset, which Blume serves from `public/` at the site
 * root and does *not* move under `basePath`. Bare page links (`/guide`) have no
 * extension. The rare dotted route (`/releases/v1.0`) is left un-based here; the
 * build-time link checker still resolves it against the route set.
 */
const ASSET_PATH = /\.[a-z0-9]+$/iu;

/** Strip any `#fragment`/`?query` so only the path is extension-tested. */
const pathOf = (url: string): string => url.replace(/[#?].*$/u, "");

/** Only a string URL can be rebased; MDAST allows null or absent urls. */
const isUrl = (url: string | null | undefined): url is string =>
  typeof url === "string";

/**
 * Satteri MDAST plugin that prepends the served-URL base — `deployment.base`
 * layered over the site-wide `basePath` — to root-relative internal page links
 * (`[x](/guide)` -> `/base/docs/guide`), so authors write links as if mounted
 * at root. Idempotent per layer (via `withComposedBasePath`, so a hand-written
 * `/docs/x` isn't double-prefixed) and inert for external URLs, fragments,
 * relative paths, images, and asset links. Only constructed when a base is set
 * (see `markdown/index.ts`).
 */
export const baseLinksPlugin = (deployBase: string, basePath: string) => {
  const rebase = (node: UrlNode, ctx: MdastUrlContext): void => {
    const { url } = node;
    if (isUrl(url) && isInternalPath(url) && !ASSET_PATH.test(pathOf(url))) {
      const next = withComposedBasePath(deployBase, basePath, url);
      if (next !== url) {
        ctx.setProperty(node, "url", next);
      }
    }
  };
  // `link` covers inline links; `definition` covers reference-style link
  // definitions (`[x]: /guide`). `image` is intentionally excluded — images are
  // public assets served at the site root, unaffected by `basePath`.
  return {
    definition: rebase,
    link: rebase,
    name: "blume-base-links",
  };
};
