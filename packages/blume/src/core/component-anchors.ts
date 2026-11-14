import type { Nodes, Root } from "mdast";
import { mdxToMdast } from "satteri";
import ts from "typescript";

import type { EvaluatedValue } from "../ai/component-markdown.ts";
import { readStaticExpression } from "../ai/static-expression.ts";
import { componentAnchorId, componentSlug } from "../components/slug.ts";
import { MDX_BODY_FEATURES } from "../markdown/features.ts";
import { BUILTIN_CHILD_PROPS } from "./builtin-tags.ts";
import type { JsxElement } from "./mdx-elements.ts";

type Frontmatter = Record<string, EvaluatedValue>;

/** What {@link extractComponentAnchors} reads besides the body. */
export interface ComponentAnchorOptions {
  /** The page's front matter, which `{frontmatter.<key>}` props read. */
  frontmatter?: Frontmatter;
  /**
   * The tags the project renders with its own components: its islands and
   * the built-ins its `components.ts` overrides. What those render can't be
   * known, so neither they nor their content count.
   */
  ownComponents?: ReadonlySet<string>;
}

// A body that may hold a built-in that renders an id or opens from the hash.
const ID_HINT = /<(?:AccordionItem|Expandable|Tab)[\s/>]/u;

/**
 * The built-ins that render their children where they're written, so an id
 * inside one lands on the page: each one in {@link BUILTIN_CHILD_PROPS} but
 * `<Prompt>`, which shows its children as text to copy (`<Visibility>` and
 * `<CodeBlock>` are read case by case), and the field, tree, and color
 * components. A test checks this against the `.astro` files.
 */
export const RENDERS_CHILDREN: ReadonlySet<string> = new Set([
  ...[...BUILTIN_CHILD_PROPS.keys()].filter((tag) => tag !== "Prompt"),
  "Color",
  "Color.Row",
  "FileTree",
  "ParamField",
  "ResponseField",
  "Tree",
  "Tree.Folder",
  "TypeTable",
]);

// A prop that can't be known here: any spread (`{...props}`) on the element
// makes every prop unknown, and an expression that isn't literal data makes
// its own prop unknown.
const UNKNOWN = Symbol("unknown");

const isString = <Value>(value: Value): value is Value & string =>
  typeof value === "string";

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
): EvaluatedValue | typeof UNKNOWN => {
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

/**
 * The anchor an accordion item or a tab answers to, by the components' own
 * {@link componentAnchorId}, or `null` when it can't be known. With `titled`
 * false (a tab outside a group that opens from the hash) only an `id` counts.
 */
const anchorOf = (
  node: JsxElement,
  frontmatter: Frontmatter | undefined,
  titled = true
): string | null => {
  const id = idProp(node, frontmatter);
  const title = titled ? stringProp(node, "title", frontmatter) : null;
  if (id === null || (id === undefined && !isString(title))) {
    return null;
  }
  return componentAnchorId(id, title ?? "");
};

/**
 * Whether a `<Tabs>` group opens a tab from the URL hash, as `Tabs.astro`
 * does: with no `param` and a `hash` that isn't `false`. `data-param={param}`
 * renders nothing for `null` and an empty value for `""`, which the script
 * reads as no param; any other value, `false` and `true` included, renders as
 * text and is one. A group whose props can't be known, or whose `hash` is an
 * object or array (the component compares `String(hash)`), counts as one
 * that doesn't.
 */
const opensFromHash = (
  node: JsxElement,
  frontmatter: Frontmatter | undefined
): boolean => {
  const hash = readProp(node, "hash", frontmatter);
  const param = readProp(node, "param", frontmatter);
  return (
    hash !== UNKNOWN &&
    hash !== false &&
    hash !== "false" &&
    !(hash instanceof Object) &&
    (param === undefined || param === null || param === "")
  );
};

/** The names a declaration's binding pattern (`{ a, b: [c] }`) binds. */
const patternNames = (name: ts.BindingName): string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? patternNames(element.name) : []
      );

/** The value names one statement binds; types and re-exports bind none. */
const statementBindings = (statement: ts.Statement): string[] => {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) {
      return [];
    }
    const bindings = clause.namedBindings;
    const named =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.flatMap((element) =>
            element.isTypeOnly ? [] : [element.name.text]
          )
        : [];
    return [
      ...(clause.name ? [clause.name.text] : []),
      ...(bindings && ts.isNamespaceImport(bindings)
        ? [bindings.name.text]
        : named),
    ];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      patternNames(declaration.name)
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }
  return [];
};

// How the page's statements are read: TypeScript and JSX both parse.
const MODULE_FILE = "page.tsx";

/**
 * The names the page's `import` and `export` statements bind. In MDX a tag
 * named by one is the page's own component, not the built-in. `null` when
 * the statements don't parse, so what they bind can't be known.
 */
const moduleBindings = (tree: Root): Set<string> | null => {
  const source = tree.children
    .flatMap((child) => (child.type === "mdxjsEsm" ? [child.value] : []))
    .join("\n");
  if (!source) {
    return new Set();
  }
  const { diagnostics = [] } = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
    fileName: MODULE_FILE,
    reportDiagnostics: true,
  });
  if (diagnostics.length > 0) {
    return null;
  }
  const file = ts.createSourceFile(
    MODULE_FILE,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  );
  return new Set(file.statements.flatMap(statementBindings));
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
 * is markup, and a built-in in {@link RENDERS_CHILDREN} (a `<CodeBlock>` only
 * without `code`). A directive's label, a text or leaf directive, and an
 * unreferenced footnote can be written out as text or not at all, and any
 * other component may not render its content.
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
  return RENDERS_CHILDREN.has(name);
};

/**
 * The fragments Blume's own MDX components answer to in an `.mdx` body —
 * targets `blume validate` accepts alongside heading slugs and raw HTML ids.
 * Each mirrors its component:
 *
 * - `<AccordionItem>`: its `id`, else its `title` slugged
 *   ({@link componentAnchorId}).
 * - `<Expandable>`: an accordion item with its `title`. An untitled one shows
 *   the localized "Show more", so it has no id that holds in every locale.
 * - `<Tab>`: its `id`, which `Tab.astro` always renders, and, in a `<Tabs>`
 *   group that opens from the hash ({@link opensFromHash}), its title
 *   slugged, the hash key a tab without an `id` answers to. `<CodeGroup>`,
 *   `<RequestExample>`, and `<ResponseExample>` render their tabs in a group
 *   that doesn't open from the hash.
 *
 * An id counts when it is on the page, as a heading's does, whether or not
 * its panel or accordion is open. Accordions (expandables included) are
 * de-duplicated as their script does it (see {@link dedupe}).
 *
 * Only content that renders is walked (see {@link rendersChildren}): not a
 * `<Prompt>`'s, a `<Visibility for="agents">`'s, or that of a component the
 * page imports or exports itself or the project provides (`ownComponents`),
 * which may not render it. Prop expressions are read as literal data, with
 * `frontmatter` behind `frontmatter.<key>`. The body is parsed only when a
 * cheap test finds a candidate; one MDX can't parse, or whose statements
 * don't parse, gives none.
 */
export const extractComponentAnchors = (
  body: string,
  options: ComponentAnchorOptions = {}
): string[] => {
  if (!ID_HINT.test(body)) {
    return [];
  }
  let tree: Nodes;
  try {
    tree = mdxToMdast(body, { features: MDX_BODY_FEATURES });
  } catch {
    return [];
  }
  const bound = tree.type === "root" ? moduleBindings(tree) : null;
  if (!bound) {
    return [];
  }
  const { frontmatter, ownComponents } = options;
  // A tag is the page's or the project's own when its name, or the object a
  // member tag (`Tree.Folder`) reads, is.
  const isOwn = (name: string): boolean => {
    const [object = name] = name.split(".");
    return [name, object].some(
      (candidate) =>
        bound.has(candidate) || ownComponents?.has(candidate) === true
    );
  };
  const accordions: (string | null)[] = [];
  const tabs: string[] = [];
  const walk = (node: Nodes, inHashGroup: boolean): void => {
    let childHashGroup = inHashGroup;
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name && isOwn(node.name)) {
        return;
      }
      switch (node.name) {
        case "Visibility": {
          // `Visibility.astro` renders nothing on the web for `for="agents"`.
          const audience = readProp(node, "for", frontmatter);
          if (audience === "agents" || audience === UNKNOWN) {
            return;
          }
          break;
        }
        case "AccordionItem": {
          accordions.push(anchorOf(node, frontmatter));
          break;
        }
        case "Expandable": {
          const title = stringProp(node, "title", frontmatter);
          accordions.push(isString(title) ? componentSlug(title) : null);
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
          const fragment = anchorOf(node, frontmatter, inHashGroup);
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
