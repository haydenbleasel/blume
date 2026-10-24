import { fileURLToPath } from "node:url";

import { dirname, join, normalize } from "pathe";

import { RUNTIME_MODULE_FILES } from "../astro/runtime-modules.ts";
import { contentAssetUrl } from "../core/content-assets.ts";
import {
  resolveRelativeFile,
  resolveRelativeImage,
} from "../core/relative-files.ts";
import {
  isLinkElementUrl,
  rewriteElementUrls,
} from "../core/sources/normalize.ts";
import type { MdastNode, MdastValue } from "./mdast.ts";
import { snapshotReader } from "./route-snapshot.ts";

/** An MDX JSX attribute, as the plugin reads it. */
interface JsxAttribute {
  [key: string]: MdastValue;
  name?: string;
  type?: string;
  value?: MdastValue;
}

/** An MDX JSX element (`<Card img="./cover.png" />`), as the plugin reads it. */
interface JsxNode extends MdastNode {
  attributes?: JsxAttribute[];
  children?: MdastValue[];
  name?: string | null;
}

/** A link or a reference definition (`[spec]: ./spec.pdf`). */
interface UrlNode extends MdastNode {
  url?: string | null;
}

/** Raw HTML in a `.md` page. */
interface HtmlNode extends MdastNode {
  value: string;
}

/** The visitor-context slice this plugin uses (see `mdast.ts` for the model). */
interface ContentAssetsContext {
  fileURL: URL | undefined;
  replaceNode: (node: MdastNode, replacement: MdastNode) => void;
  setProperty: (node: MdastNode, key: "url" | "value", value: string) => void;
}

export interface ContentAssetsPluginOptions {
  /**
   * The `blume:data` snapshot file an ejected app aliases. The served
   * content-assets map is written beside it, and read from there when no CLI
   * publishes it.
   */
  dataFile?: string;
  /** Astro's `deployment.base` subdirectory (`""` or `/seg`). */
  deployBase?: string;
}

/** A plain string attribute value; an expression value isn't a path. */
const isStringValue = (value: MdastValue): value is string =>
  typeof value === "string";

/** The directory of the page being compiled, when the compiler names it. */
const pageDir = (ctx: ContentAssetsContext): string | undefined =>
  ctx.fileURL ? dirname(normalize(fileURLToPath(ctx.fileURL))) : undefined;

/**
 * Satteri MDAST plugin that points a page's references to files beside it at
 * their served copies (`/blume-assets/content/…`), the way a colocated
 * `![](./cover.png)` is published: a `<Card img="./cover.png">`, a link or a
 * reference definition naming a file (`[spec](./spec.pdf)`), and an
 * element's `src` or `href` (`<img src="./diagram.png">`, `<a href>`, a
 * component's `href`) in `.mdx`, or in a `.md` page's raw HTML. Left as
 * written, each ships as a relative URL the browser resolves against the
 * page's URL, where nothing is served. A card's image is resolved from
 * beside the page as an embed is (`resolveRelativeImage`), and any other
 * file as `resolveRelativeFile` finds one; an included partial's were
 * already rebased onto the page by the include expander. A reference is
 * rewritten only when the content-assets endpoint serves its file: the map
 * `collectContentAssets` builds over the same references. Anything else is
 * left as written, and `blume validate` reports it.
 */
export const contentAssetsPlugin = (
  options: ContentAssetsPluginOptions = {}
) => {
  const assetsFile = options.dataFile
    ? join(
        dirname(options.dataFile),
        RUNTIME_MODULE_FILES.get("blume:content-assets") ?? ""
      )
    : undefined;
  const readAssets = snapshotReader("blume:content-assets", assetsFile);

  // The map is published as `param → absolute path`; parsed once per
  // published text and inverted, so each reference looks its file up directly.
  let cached: { params: Map<string, string>; text: string } | undefined;
  const servedParams = (): Map<string, string> | undefined => {
    const text = readAssets();
    if (text === undefined) {
      return undefined;
    }
    if (cached?.text !== text) {
      const files: Record<string, string> = JSON.parse(text);
      cached = {
        params: new Map(
          Object.entries(files).map(([param, path]) => [normalize(path), param])
        ),
        text,
      };
    }
    return cached.params;
  };

  /** The served URL of `file`, or undefined when the endpoint doesn't serve it. */
  const servedUrl = (file: string | null, suffix = ""): string | undefined => {
    const param = file === null ? undefined : servedParams()?.get(file);
    return param === undefined
      ? undefined
      : `${contentAssetUrl(param, options.deployBase)}${suffix}`;
  };

  /** The served URL of a file a link or an element URL names beside the page. */
  const fileUrl = (dir: string, target: string): string | undefined => {
    const file = resolveRelativeFile(dir, target);
    return file ? servedUrl(file.path, file.suffix) : undefined;
  };

  const rewriteUrl = (node: UrlNode, ctx: ContentAssetsContext): void => {
    const dir = pageDir(ctx);
    const next =
      dir && isStringValue(node.url) ? fileUrl(dir, node.url) : undefined;
    if (next !== undefined) {
      ctx.setProperty(node, "url", next);
    }
  };

  const rewriteHtml = (node: HtmlNode, ctx: ContentAssetsContext): void => {
    const dir = pageDir(ctx);
    if (dir === undefined) {
      return;
    }
    // An HTML node's value is raw HTML: it holds no Markdown code, and a
    // comment in it renders nothing whether it's rewritten or not.
    const next = rewriteElementUrls(
      node.value,
      (url) =>
        isLinkElementUrl(url) ? (fileUrl(dir, url.value) ?? null) : null,
      null
    );
    if (next !== node.value) {
      ctx.setProperty(node, "value", next);
    }
  };

  /** The served URL an element's attribute is rewritten to, if any. */
  const attributeUrl = (
    dir: string,
    tag: string,
    attribute: JsxAttribute
  ): string | undefined => {
    const { name, value } = attribute;
    if (
      attribute.type !== "mdxJsxAttribute" ||
      name === undefined ||
      !isStringValue(value)
    ) {
      return undefined;
    }
    if (tag === "Card" && name === "img") {
      return servedUrl(resolveRelativeImage(dir, value));
    }
    return isLinkElementUrl({ attribute: name, tag, value })
      ? fileUrl(dir, value)
      : undefined;
  };

  const rewriteElement = (node: JsxNode, ctx: ContentAssetsContext): void => {
    const dir = pageDir(ctx);
    const { name } = node;
    if (!(dir && name)) {
      return;
    }
    const attributes = node.attributes ?? [];
    let changed = false;
    const next = attributes.map((attribute) => {
      const url = attributeUrl(dir, name, attribute);
      if (url === undefined) {
        return attribute;
      }
      changed = true;
      return { name: attribute.name, type: attribute.type, value: url };
    });
    if (changed) {
      // Sätteri can't set a JSX element's attributes in place, so the element
      // is swapped for a copy; its children carry over and are still visited.
      ctx.replaceNode(node, {
        attributes: next,
        children: node.children ?? [],
        name,
        type: node.type,
      });
    }
  };

  return {
    definition: rewriteUrl,
    html: rewriteHtml,
    link: rewriteUrl,
    mdxJsxFlowElement: rewriteElement,
    mdxJsxTextElement: rewriteElement,
    name: "blume-content-assets",
  };
};
