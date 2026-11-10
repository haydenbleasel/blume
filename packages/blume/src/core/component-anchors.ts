import { parse as parseModule } from "es-module-lexer/js";
import type { Nodes, Root } from "mdast";

import { isString } from "../ai/component-markdown.ts";
import type { EvaluatedValue } from "../ai/component-markdown.ts";
import { readStaticExpression } from "../ai/static-expression.ts";
import { componentSlug } from "../components/slug.ts";
import { BUILTIN_CHILD_PROPS } from "./builtin-tags.ts";
import { parseMdxBody } from "./mdx-elements.ts";
import type { JsxElement } from "./mdx-elements.ts";

type Frontmatter = Record<string, EvaluatedValue>;

// A body that may hold a built-in that renders an id or opens from the hash.
const ID_HINT = /<(?:AccordionItem|Expandable|Tab)[\s/>]/u;

// A prop that can't be known here: any spread (`{...props}`) on the element
// makes every prop unknown, and an expression that isn't literal data makes
// its own prop unknown.
const UNKNOWN = Symbol("unknown");

/**
 * A prop's value as the component receives it: `undefined` when the element
 * doesn't set it, `true` for a bare attribute, and `UNKNOWN` when it can't be
 * known. Expressions are read as literal data (`frontmatter.title` included),
 * never run. The last attribute with the name wins, as in JSX.
 */
const readProp = (
  node: JsxElement,
  name: string,
  frontmatter: Frontmatter | undefined
): EvaluatedValue | undefined | typeof UNKNOWN => {
  if (
    node.attributes.some((attribute) => attribute.type !== "mdxJsxAttribute")
  ) {
    return UNKNOWN;
  }
  const attribute = node.attributes.findLast(
    (candidate) =>
      candidate.type === "mdxJsxAttribute" && candidate.name === name
  );
  if (attribute?.type !== "mdxJsxAttribute") {
    return undefined;
  }
  const { value } = attribute;
  if (value === null || value === undefined) {
    return true;
  }
  if (isString(value)) {
    return value;
  }
  const read = readStaticExpression(value.value, frontmatter);
  return read.ok ? read.value : UNKNOWN;
};

/** A string prop: `undefined` when unset, `null` when set to no known string. */
const stringProp = (
  node: JsxElement,
  name: string,
  frontmatter: Frontmatter | undefined
): string | null | undefined => {
  const value = readProp(node, name, frontmatter);
  return value === undefined || isString(value) ? value : null;
};

/** The title slugged, as `componentSlug` does in the component. */
const titleSlug = (
  node: JsxElement,
  frontmatter: Frontmatter | undefined
): string | null => {
  const title = stringProp(node, "title", frontmatter);
  return isString(title) ? componentSlug(title) : null;
};

/**
 * An `id` as the component's `id ?? …` reads it: `undefined` when unset or
 * `null`, so the fallback applies; a number as the string it renders; `null`
 * for anything else: a value that can't be known, or a boolean, which renders
 * as the text `true` or `false` that no link means.
 */
const idProp = (
  node: JsxElement,
  frontmatter: Frontmatter | undefined
): string | null | undefined => {
  const value = readProp(node, "id", frontmatter);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (isString(value)) {
    return value;
  }
  return Number.isFinite(value) ? String(value) : null;
};

/** An accordion item's id: `AccordionItem.astro`'s `id ?? componentSlug(title)`. */
const accordionItemId = (
  node: JsxElement,
  frontmatter: Frontmatter | undefined
): string | null => {
  const id = idProp(node, frontmatter);
  return id === undefined ? titleSlug(node, frontmatter) : id;
};

/**
 * Whether a `<Tabs>` group opens a tab from the URL hash, as `Tabs.astro`
 * does: with no `param` and a `hash` that isn't `false`. `data-param={param}`
 * renders nothing for `null` and an empty value for `""`, which the script
 * reads as no param; any other value, `false` and `true` included, renders as
 * text and is one. A group whose props can't be known counts as one that
 * doesn't.
 */
const opensFromHash = (
  node: JsxElement,
  frontmatter: Frontmatter | undefined
): boolean => {
  const hash = readProp(node, "hash", frontmatter);
  const param = readProp(node, "param", frontmatter);
  if (hash === UNKNOWN || param === UNKNOWN) {
    return false;
  }
  // The component compares `String(hash)`; an object or array isn't read that
  // way here, so it counts as not opening from the hash.
  const plainHash =
    hash === undefined ||
    hash === null ||
    hash === true ||
    hash === false ||
    isString(hash) ||
    Number.isFinite(hash);
  return (
    plainHash &&
    (param === undefined || param === null || param === "") &&
    String(hash === undefined ? true : hash) !== "false"
  );
};

/**
 * The fragment a `<Tab>` answers to. `Tab.astro` renders `id={id}`, so an
 * `id` is always on the page; its hash key is `id ?? componentSlug(title)`,
 * so in a group that opens from the hash a tab without one answers to its
 * title slugged.
 */
const tabFragment = (
  node: JsxElement,
  inHashGroup: boolean,
  frontmatter: Frontmatter | undefined
): string | null => {
  const id = idProp(node, frontmatter);
  if (id !== undefined) {
    return id;
  }
  return inHashGroup ? titleSlug(node, frontmatter) : null;
};

/**
 * The names an import clause binds: `a`, `* as ns`, and `{ b as c, d }` bind
 * `a`, `ns`, `c`, and `d`.
 */
const clauseBindings = (source: string): string[] => {
  const names: string[] = [];
  // Comments may sit between the names; the lexer leaves them in the clause.
  const clause = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, " ");
  const named = /\{(?<list>[^}]*)\}/u.exec(clause);
  for (const part of named?.groups?.list?.split(",") ?? []) {
    const name = part
      .split(/\sas\s/u)
      .at(-1)
      ?.trim();
    if (name) {
      names.push(name);
    }
  }
  for (const part of clause.replace(/\{[^}]*\}/u, "").split(",")) {
    const name = part.replace(/^\s*\*\s*as\s/u, "").trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
};

/**
 * The names the page's `import` and `export` statements bind. In MDX a tag
 * named by one is the page's own component, not the built-in. `null` when
 * the statements can't be read.
 */
const moduleBindings = (tree: Root): Set<string> | null => {
  const names = new Set<string>();
  for (const child of tree.children) {
    if (child.type !== "mdxjsEsm") {
      continue;
    }
    let lexed: ReturnType<typeof parseModule>;
    try {
      lexed = parseModule(child.value);
    } catch {
      return null;
    }
    const [imports, exports] = lexed;
    for (const entry of imports) {
      // `export { a } from "x"` is listed as an import too, but binds nothing.
      if (
        entry.type === "static" &&
        !entry.typeOnly &&
        !child.value.startsWith("export", entry.importStart)
      ) {
        // The clause between `import` and the specifier's opening quote.
        const clause = child.value
          .slice(entry.importStart, entry.start - 1)
          .replace(/^import(?![\w$])\s*(?:(?:defer|source)\s+)?/u, "")
          .replace(/\s*from\s*$/u, "");
        for (const name of clauseBindings(clause)) {
          names.add(name);
        }
      }
    }
    for (const entry of exports) {
      // Only a value declaration binds a name; a type or a re-export doesn't.
      if (entry.type === "direct" && !entry.typeOnly && entry.localName) {
        names.add(entry.localName);
      }
    }
  }
  return names;
};

/**
 * Repeats suffixed the way the accordion script de-duplicates ids on a page:
 * the first keeps the plain id, later ones gain `-2`, `-3`. An id that can't
 * be known is left out of the count here; on the page it only pushes later
 * repeats one suffix further, so every id given here is still on the page,
 * perhaps on another item.
 */
const dedupe = (ids: (string | null)[]): string[] => {
  const seen = new Map<string, number>();
  return ids.flatMap((id) => {
    if (id === null) {
      return [];
    }
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return [count === 0 ? id : `${id}-${count + 1}`];
  });
};

// HTML elements whose content never becomes elements on the page: a
// template's stays inert, and the rest parse it as text.
const INERT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "select",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
]);

/**
 * Whether a node's content renders where an id in it lands: Markdown does, as
 * do a container directive's body (`:::note`), an HTML element whose content
 * is markup, and a built-in that shows its children (a `<CodeBlock>` only
 * without `code`). A directive's label, a text or leaf directive, and an
 * unreferenced footnote can be written out as text or not at all, and a
 * built-in that shows no children, or any other component, may not render
 * its content.
 */
const rendersChildren = (
  node: Nodes,
  frontmatter: Frontmatter | undefined
): boolean => {
  if (
    node.type === "textDirective" ||
    node.type === "leafDirective" ||
    node.type === "footnoteDefinition" ||
    (node.type === "paragraph" &&
      node.data !== undefined &&
      "directiveLabel" in node.data)
  ) {
    return false;
  }
  if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") {
    return true;
  }
  const { name } = node;
  if (!name) {
    return true;
  }
  // An HTML element has a lowercase name, unlike a member such as `ui.Panel`.
  if (/^[a-z][\w-]*$/u.test(name)) {
    return !INERT_ELEMENTS.has(name);
  }
  if (name === "CodeBlock") {
    return readProp(node, "code", frontmatter) === undefined;
  }
  return BUILTIN_CHILD_PROPS.has(name);
};

/**
 * The fragments Blume's own MDX components answer to in an `.mdx` body —
 * targets `blume validate` accepts alongside heading slugs and raw HTML ids.
 * Each mirrors its component:
 *
 * - `<AccordionItem>`: its `id`, else its `title` slugged.
 * - `<Expandable>`: an accordion item with its `title`. An untitled one shows
 *   the localized "Show more", so it has no id that holds in every locale.
 * - `<Tab>`: see {@link tabFragment}. `<CodeGroup>`, `<RequestExample>`, and
 *   `<ResponseExample>` render their tabs in a group that doesn't open from
 *   the hash.
 *
 * An id counts when it is on the page, as a heading's does, whether or not
 * its panel or accordion is open.
 *
 * Only content that renders is walked: see {@link rendersChildren}.
 *
 * Accordions (expandables included) are de-duplicated as their script does
 * it (see {@link dedupe}).
 * Content that never renders on the web page gives none: a `<Prompt>`'s,
 * and a `<Visibility for="agents">`'s. Prop expressions are read as literal
 * data, with `frontmatter` behind `frontmatter.<key>`. A tag the page imports
 * or exports itself is its own component, so neither it nor its content
 * counts; one `components.ts` overrides is still read as the built-in. The
 * body is parsed only when a cheap test finds a candidate; one MDX can't
 * parse, or whose statements can't be read, gives none.
 */
export const extractComponentAnchors = (
  body: string,
  frontmatter?: Frontmatter
): string[] => {
  if (!ID_HINT.test(body)) {
    return [];
  }
  const tree = parseMdxBody(body);
  const bound = tree?.type === "root" ? moduleBindings(tree) : null;
  if (!(tree && bound)) {
    return [];
  }
  const accordions: (string | null)[] = [];
  const tabs: string[] = [];
  const walk = (node: Nodes, inHashGroup: boolean): void => {
    let childHashGroup = inHashGroup;
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name && bound.has(node.name)) {
        // The page's own component: what it and its content render can't be
        // known here.
        return;
      }
      switch (node.name) {
        case "Prompt": {
          return;
        }
        case "Visibility": {
          // `Visibility.astro` renders nothing on the web for `for="agents"`.
          const audience = readProp(node, "for", frontmatter);
          if (audience === "agents" || audience === UNKNOWN) {
            return;
          }
          break;
        }
        case "AccordionItem": {
          accordions.push(accordionItemId(node, frontmatter));
          break;
        }
        case "Expandable": {
          accordions.push(titleSlug(node, frontmatter));
          break;
        }
        case "Tabs": {
          childHashGroup = opensFromHash(node, frontmatter);
          break;
        }
        case "CodeGroup":
        case "RequestExample":
        case "ResponseExample": {
          childHashGroup = false;
          break;
        }
        case "Tab": {
          const fragment = tabFragment(node, inHashGroup, frontmatter);
          if (fragment !== null) {
            tabs.push(fragment);
          }
          break;
        }
        default: {
          break;
        }
      }
    }
    if (rendersChildren(node, frontmatter) && "children" in node) {
      for (const child of node.children) {
        walk(child, childHashGroup);
      }
    }
  };
  try {
    walk(tree, false);
  } catch {
    // Nesting deep enough to overflow the stack: give none rather than fail
    // the scan.
    return [];
  }
  return [
    ...new Set([...dedupe(accordions), ...tabs].filter((id) => id !== "")),
  ];
};
