/**
 * The MDX component tags Blume ships (the keys of the catch-all's component map,
 * plus composed sub-parts like `Color.Item`/`Tree.File`). Used by the
 * missing-component diagnostic to tell an unknown `<Tag>` from a built-in. Keep
 * in sync with the component map in `astro/templates.ts`.
 */
export const BUILTIN_MDX_TAGS = new Set<string>([
  "Accordion",
  "AccordionItem",
  "ApiOverview",
  "ApiTagOperations",
  "AutoTypeTable",
  "Badge",
  "Blog",
  "Callout",
  "Card",
  "CardGroup",
  "Changelog",
  "CodeBlock",
  "CodeGroup",
  "Color",
  "Column",
  "Columns",
  "Component",
  "Diff",
  "Expandable",
  "FileTree",
  "Frame",
  "GithubInfo",
  "Icon",
  // Conditionally imported by the catch-all, but `detectUsesMath` matches any
  // authored `<Math`, so it is always wired wherever it can appear.
  "Math",
  "Operation",
  "Panel",
  "ParamField",
  "Prompt",
  "RequestExample",
  "ResponseExample",
  "ResponseField",
  "Step",
  "Steps",
  "Tab",
  "Tabs",
  "Tile",
  "Tooltip",
  "Tree",
  "TypeTable",
  "View",
  "Visibility",
  "YouTube",
]);

/**
 * The props each built-in that shows its children takes, keyed by MDX tag. A
 * childless use with any other prop renders without the content its author
 * meant it to carry (VitePress writes `<Badge type="tip" text="beta" />`, and
 * Blume's Badge shows only its children), which the unknown-prop diagnostic
 * reports. Each list is the component's own `Props` (or what it reads from
 * `Astro.props`); a test checks them against the `.astro` files.
 */
export const BUILTIN_CHILD_PROPS: ReadonlyMap<string, readonly string[]> =
  new Map([
    ["Accordion", []],
    ["AccordionItem", ["defaultOpen", "description", "icon", "id", "title"]],
    [
      "Badge",
      [
        "class",
        "className",
        "color",
        "disabled",
        "icon",
        "shape",
        "size",
        "stroke",
        "tooltip",
        "variant",
      ],
    ],
    ["Callout", ["color", "icon", "title", "type"]],
    [
      "Card",
      [
        "arrow",
        "color",
        "cta",
        "horizontal",
        "href",
        "icon",
        "img",
        "title",
        "type",
      ],
    ],
    ["CardGroup", ["cols"]],
    ["CodeBlock", ["code", "icons", "lang", "title"]],
    ["CodeGroup", ["dropdown"]],
    ["Column", []],
    ["Columns", ["cols"]],
    ["Expandable", ["defaultOpen", "title"]],
    ["Frame", ["caption", "hint"]],
    ["Panel", ["title"]],
    ["Prompt", ["actions", "description"]],
    ["RequestExample", ["dropdown"]],
    ["ResponseExample", ["dropdown"]],
    ["Step", ["icon", "title"]],
    ["Steps", ["titleSize"]],
    ["Tab", ["class", "icon", "id", "style", "title"]],
    [
      "Tabs",
      [
        "borderBottom",
        "defaultTabIndex",
        "dropdown",
        "hash",
        "inline",
        "param",
        "sync",
        "syncKey",
      ],
    ],
    ["Tile", ["description", "href", "title"]],
    ["Tooltip", ["cta", "headline", "href", "tip"]],
    ["View", ["class", "icon", "title"]],
    ["Visibility", ["for"]],
  ]);
