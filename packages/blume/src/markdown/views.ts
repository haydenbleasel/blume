import type { MdastNode, MdastValue } from "./mdast.ts";

/**
 * A page's views: the `<View title>` blocks it's written in, as Mintlify
 * writes them. Each distinct title is one option of the page's view picker,
 * in the order the page first uses it, and several blocks can share a title.
 * The plugin reads them off the tree and hands the list to the page template
 * through the render's frontmatter, so the picker renders with the page
 * instead of after it (see `ViewSwitcher.astro`).
 */

/** The render-frontmatter key the page's views travel on. */
export const VIEWS_KEY = "blumeViews";

/** One option of the view picker. */
export interface PageView {
  icon?: string;
  title: string;
}

/** The root, as the plugin's `after` hook receives it. */
interface ViewsRoot {
  children: MdastNode[];
}

/** The slice of Satteri's visitor context the plugin uses. */
export interface ViewsContext {
  data?: { astro?: { frontmatter?: Record<string, MdastValue> } };
}

const isNode = (value: MdastValue): value is MdastNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: MdastValue): value is string =>
  typeof value === "string";

/** A JSX element's literal string attribute, when it has one. */
const stringAttribute = (node: MdastNode, name: string): string | undefined => {
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  const value = attributes.find(
    (attribute) => isNode(attribute) && attribute.name === name
  );
  return isNode(value) && isText(value.value) && value.value.trim() !== ""
    ? value.value.trim()
    : undefined;
};

/** Every `<View>` element under `nodes`, in document order. */
const viewElements = (nodes: readonly MdastValue[]): MdastNode[] =>
  nodes
    .filter(isNode)
    .flatMap((node) => [
      ...(node.type === "mdxJsxFlowElement" && node.name === "View"
        ? [node]
        : []),
      ...viewElements(Array.isArray(node.children) ? node.children : []),
    ]);

/** The page's views, one per distinct title, in first-use order. */
export const pageViews = (nodes: readonly MdastValue[]): PageView[] => {
  const views = new Map<string, PageView>();
  for (const element of viewElements(nodes)) {
    const title = stringAttribute(element, "title");
    if (title !== undefined && !views.has(title)) {
      const icon = stringAttribute(element, "icon");
      views.set(title, icon === undefined ? { title } : { icon, title });
    }
  }
  return [...views.values()];
};

export const viewsPlugin = () => ({
  after(root: ViewsRoot, ctx: ViewsContext) {
    const frontmatter = ctx.data?.astro?.frontmatter;
    const views = pageViews(root.children);
    // A page with one view has nothing to switch between.
    if (frontmatter && views.length > 1) {
      frontmatter[VIEWS_KEY] = views.map((view) => ({ ...view }));
    }
  },
  name: "blume-views",
});
