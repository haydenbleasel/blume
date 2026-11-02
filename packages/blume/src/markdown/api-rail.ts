import type { EvaluatedValue } from "../ai/component-markdown.ts";
import { readStaticExpression } from "../ai/static-expression.ts";
import { PARAM_LOCATIONS } from "../components/content/api-field.ts";
import type { FieldValue } from "../components/content/api-field.ts";
import {
  AUTH_METHODS,
  PLAYGROUND_MODES,
  parseApiEndpoint,
} from "../components/content/api-page.ts";
import type {
  EndpointField,
  EndpointSpec,
} from "../components/content/api-page.ts";
import { jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastValue } from "./mdast.ts";

/**
 * The right-hand column of a hand-written API page, as Mintlify renders one.
 * Top-level `<RequestExample>` and `<ResponseExample>` move into an
 * `<ApiRail>` at the end of the document, request examples first, and the
 * render is flagged so the layout makes room for the column (see
 * `ApiRail.astro`). Below `xl` the rail follows the page's content, and the
 * examples are ordinary code groups there. An example nested in another
 * component stays where it is written.
 *
 * A page with `api` frontmatter (`POST /v1/users`) also gets its endpoint: the
 * method and path at the top of the page (`<ApiEndpoint>`), and at the head of
 * the rail a Try it panel and request samples (`<ApiPlayground>`) built from
 * the page's `<ParamField>`s, which the plugin collects here, nested body
 * fields included (see `components/content/api-page.ts`).
 */

/** The render-frontmatter key that tells the layout a page has a rail. */
export const API_RAIL_KEY = "blumeApiRail";

/** The components that move to the rail, in the order they stack there. */
const RAIL_COMPONENTS = ["RequestExample", "ResponseExample"];

/** The root, as the plugin's `after` hook receives it. */
interface RailRoot {
  children: MdastNode[];
}

/** The slice of Satteri's visitor context the plugin uses. */
export interface ApiRailContext {
  appendChild: (node: RailRoot, child: MdastNode) => void;
  data?: { astro?: { frontmatter?: Record<string, EvaluatedValue> } };
  insertChildAt: (node: RailRoot, index: number, child: MdastNode) => void;
  removeNode: (node: MdastNode) => void;
}

/**
 * A detached copy of a node Satteri materialized lazily: its own fields,
 * children included, without the arena handles that tie it to its old place.
 * Appending the original instead would move an empty shell.
 */
const detach = (node: MdastNode): MdastNode =>
  JSON.parse(
    JSON.stringify(node, (key: string, value: MdastValue) =>
      key === "_id" || key === "_resolver" ? undefined : value
    )
  );

const isName = <Value>(value: Value): value is Value & string =>
  typeof value === "string";

const railIndex = (node: MdastNode): number =>
  node.type === "mdxJsxFlowElement" && isName(node.name)
    ? RAIL_COMPONENTS.indexOf(node.name)
    : -1;

/** An element's name, when it is a JSX element. */
const elementName = (node: MdastNode): string | undefined =>
  node.type === "mdxJsxFlowElement" && isName(node.name)
    ? node.name
    : undefined;

const isNode = (value: MdastValue): value is MdastNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A node's children, when it has any. */
const childrenOf = (node: MdastNode): MdastNode[] =>
  Array.isArray(node.children) ? node.children.filter(isNode) : [];

/**
 * One JSX attribute, as the parser leaves it. The parser names every one: a
 * spread (`{...props}`) is an `mdxJsxExpressionAttribute`, not one of these.
 */
interface JsxAttribute {
  name: string;
  type: string;
  value?: string | { value: string } | null;
}

const isAttribute = (value: MdastValue): value is JsxAttribute & MdastNode =>
  isNode(value) && value.type === "mdxJsxAttribute";

/** An element's attributes, name to value. */
interface AttributeValues {
  [name: string]: EvaluatedValue;
}

/**
 * An element's attributes as values: text, shorthand flags as `true`, and
 * expressions read as literal data (see `ai/static-expression.ts`); one that
 * isn't literal is left out.
 */
const attributeValues = (
  node: MdastNode,
  frontmatter: Record<string, EvaluatedValue> | undefined
): AttributeValues => {
  const values: AttributeValues = {};
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  for (const attribute of attributes.filter(isAttribute)) {
    const { name, value } = attribute;
    if (value === null || value === undefined) {
      values[name] = true;
    } else if (isName(value)) {
      values[name] = value;
    } else {
      const read = readStaticExpression(value.value, frontmatter);
      if (read.ok) {
        values[name] = read.value;
      }
    }
  }
  return values;
};

const isFlag = (value: EvaluatedValue): boolean =>
  value === true || value === "true";

/** A `<ParamField>`'s values as an endpoint field, or `null` with no location. */
const endpointField = (values: AttributeValues): EndpointField | null => {
  const location = PARAM_LOCATIONS.find((key) => isName(values[key]));
  const name = location ? values[location] : undefined;
  if (!(location && isName(name))) {
    return null;
  }
  const field: EndpointField = { location, name };
  if (isName(values.type)) {
    field.type = values.type;
  }
  if (isName(values.placeholder)) {
    field.placeholder = values.placeholder;
  }
  if (isFlag(values.required)) {
    field.required = true;
  }
  if (isFlag(values.deprecated)) {
    field.deprecated = true;
  }
  if (values.default !== undefined) {
    // SAFETY: an attribute's literal data is JSON-shaped; a frontmatter
    // date only arrives through `frontmatter.*`, which a default never reads.
    field.default = values.default as FieldValue;
  }
  return field;
};

/**
 * The `<ParamField>`s under `nodes`, in document order. A field's own nested
 * fields (in its `<Expandable>`) become its `fields`, the properties of the
 * object it describes.
 */
const collectFields = (
  nodes: MdastNode[],
  frontmatter: Record<string, EvaluatedValue> | undefined
): EndpointField[] =>
  nodes.flatMap((node) => {
    const nested = collectFields(childrenOf(node), frontmatter);
    if (elementName(node) !== "ParamField") {
      return nested;
    }
    const field = endpointField(attributeValues(node, frontmatter));
    if (!field) {
      return nested;
    }
    return nested.length > 0 ? [{ ...field, fields: nested }] : [field];
  });

/** The page's endpoint, when its `api` frontmatter names one. */
const endpointSpec = (
  root: RailRoot,
  frontmatter: Record<string, EvaluatedValue> | undefined,
  requestExample: boolean
): EndpointSpec | null => {
  const api = frontmatter?.api;
  const endpoint = isName(api) ? parseApiEndpoint(api) : null;
  if (!endpoint) {
    return null;
  }
  const spec: EndpointSpec = {
    fields: collectFields(root.children, frontmatter),
    method: endpoint.method,
    requestExample,
    target: endpoint.target,
  };
  const authMethod = AUTH_METHODS.find(
    (method) => method === frontmatter?.authMethod
  );
  if (authMethod) {
    spec.authMethod = authMethod;
  }
  const playground = PLAYGROUND_MODES.find(
    (mode) => mode === frontmatter?.playground
  );
  if (playground) {
    spec.playground = playground;
  }
  return spec;
};

/** Where the endpoint header goes: after a front matter block, if any. */
const headerIndex = (root: RailRoot): number =>
  root.children.findIndex(
    (node) => node.type !== "yaml" && node.type !== "toml"
  );

export const apiRailPlugin = () => ({
  after(root: RailRoot, ctx: ApiRailContext) {
    const frontmatter = ctx.data?.astro?.frontmatter;
    const examples = root.children.filter((node) => railIndex(node) !== -1);
    const spec = endpointSpec(
      root,
      frontmatter,
      examples.some((node) => railIndex(node) === 0)
    );
    const specAttribute = spec
      ? [jsxAttribute("spec", JSON.stringify(spec))]
      : [];
    const playground =
      spec && spec.playground !== "none"
        ? [jsxFlowElement("ApiPlayground", specAttribute, [])]
        : [];
    for (const example of examples) {
      ctx.removeNode(example);
    }
    if (spec) {
      ctx.insertChildAt(
        root,
        Math.max(headerIndex(root), 0),
        jsxFlowElement("ApiEndpoint", specAttribute, [])
      );
    }
    const rail = [
      ...playground,
      ...examples.toSorted((a, b) => railIndex(a) - railIndex(b)).map(detach),
    ];
    if (rail.length === 0) {
      return;
    }
    ctx.appendChild(root, jsxFlowElement("ApiRail", [], rail));
    if (frontmatter) {
      frontmatter[API_RAIL_KEY] = true;
    }
  },
  name: "blume-api-rail",
});
