import { join } from "pathe";

import { packageRoot } from "../core/package-root.ts";

/** A file copied into the user's project by `blume add`. */
export interface RegistryFile {
  /** Path to the source file, relative to the blume package `src` directory. */
  source: string;
  /** Destination path relative to the project root. */
  target: string;
  /** Rewrite the file's relative imports to `blume/*` specifiers on copy. */
  rewrite?: boolean;
}

export interface RegistryItem {
  name: string;
  description: string;
  files: RegistryFile[];
  /** Lines printed after install to guide the user. */
  postInstall: string[];
}

/** Absolute path to the blume package `src` directory (the copy source root). */
export const packageSrc = join(packageRoot(), "src");

/**
 * A built-in layout component offered as editable source. `blume add` rewrites
 * its relative imports to `blume/*`, so it renders identically to the built-in
 * until the user changes it, then registers under the matching `layout` slot.
 */
const layoutComponent = (config: {
  name: string;
  description: string;
  /** Source basename under `src/components/layout`. */
  file: string;
  /** Layout slot key, also the import name in the post-install hint. */
  slot: string;
}): RegistryItem => {
  const target = `components/blume/${config.file}`;
  return {
    description: config.description,
    files: [
      {
        rewrite: true,
        source: `components/layout/${config.file}`,
        target,
      },
    ],
    name: config.name,
    postInstall: [
      "Register it in components.ts:",
      '  import { defineComponents } from "blume";',
      `  import ${config.slot} from "./${target}";`,
      "",
      `  export default defineComponents({ layout: { ${config.slot} } });`,
      "",
      "It imports the rest from `blume/*`, so it matches the built-in until you edit it.",
    ],
  };
};

/**
 * A built-in MDX content component offered as editable source. Like
 * {@link layoutComponent}, but registered under the `mdx` map (the tag you write
 * in `.mdx`) rather than a `layout` slot.
 */
const contentComponent = (config: {
  name: string;
  description: string;
  /** Source basename under `src/components/content`. */
  file: string;
  /** MDX tag / component name, also the import name in the post-install hint. */
  tag: string;
}): RegistryItem => {
  const target = `components/blume/${config.file}`;
  return {
    description: config.description,
    files: [
      {
        rewrite: true,
        source: `components/content/${config.file}`,
        target,
      },
    ],
    name: config.name,
    postInstall: [
      "Register it in components.ts:",
      '  import { defineComponents } from "blume";',
      `  import ${config.tag} from "./${target}";`,
      "",
      `  export default defineComponents({ mdx: { ${config.tag} } });`,
      "",
      "It imports the rest from `blume/*`, so it matches the built-in until you edit it.",
    ],
  };
};

/** Every user-facing content component, by `blume add` name → source basename. */
const CONTENT_COMPONENTS: {
  name: string;
  description: string;
  file: string;
  tag: string;
}[] = [
  {
    description: "Aside for notes, tips, and warnings.",
    file: "Callout.astro",
    name: "callout",
    tag: "Callout",
  },
  {
    description: "A linkable card with icon, title, and body.",
    file: "Card.astro",
    name: "card",
    tag: "Card",
  },
  {
    description: "A responsive grid of cards.",
    file: "CardGroup.astro",
    name: "card-group",
    tag: "CardGroup",
  },
  {
    description: "Tabbed code blocks for multiple languages.",
    file: "CodeGroup.astro",
    name: "code-group",
    tag: "CodeGroup",
  },
  {
    description: "A small status/label badge.",
    file: "Badge.astro",
    name: "badge",
    tag: "Badge",
  },
  {
    description: "A numbered list of steps.",
    file: "Steps.astro",
    name: "steps",
    tag: "Steps",
  },
  {
    description: "A single step within Steps.",
    file: "Step.astro",
    name: "step",
    tag: "Step",
  },
  {
    description: "A tabbed content panel.",
    file: "Tabs.astro",
    name: "tabs",
    tag: "Tabs",
  },
  {
    description: "A single tab within Tabs.",
    file: "Tab.astro",
    name: "tab",
    tag: "Tab",
  },
  {
    description: "A collapsible accordion group.",
    file: "Accordion.astro",
    name: "accordion",
    tag: "Accordion",
  },
  {
    description: "A single item within an Accordion.",
    file: "AccordionItem.astro",
    name: "accordion-item",
    tag: "AccordionItem",
  },
  {
    description: "A multi-column layout.",
    file: "Columns.astro",
    name: "columns",
    tag: "Columns",
  },
  {
    description: "A single column within Columns.",
    file: "Column.astro",
    name: "column",
    tag: "Column",
  },
  {
    description: "A bordered frame around an image or embed.",
    file: "Frame.astro",
    name: "frame",
    tag: "Frame",
  },
  {
    description: "An inline expand/collapse disclosure.",
    file: "Expandable.astro",
    name: "expandable",
    tag: "Expandable",
  },
  {
    description: "A titled content panel.",
    file: "Panel.astro",
    name: "panel",
    tag: "Panel",
  },
  {
    description: "A hover tooltip.",
    file: "Tooltip.astro",
    name: "tooltip",
    tag: "Tooltip",
  },
  {
    description: "A compact linkable tile.",
    file: "Tile.astro",
    name: "tile",
    tag: "Tile",
  },
  {
    description: "A styled prompt / terminal block.",
    file: "Prompt.astro",
    name: "prompt",
    tag: "Prompt",
  },
  {
    description: "A responsive, privacy-friendly YouTube embed.",
    file: "YouTube.astro",
    name: "youtube",
    tag: "YouTube",
  },
];

/** The built-in, Blume-owned source registry. */
export const registry: RegistryItem[] = [
  layoutComponent({
    description: "The top navigation bar (logo, search, nav links).",
    file: "Header.astro",
    name: "header",
    slot: "Header",
  }),
  layoutComponent({
    description: "The sidebar navigation tree.",
    file: "NavTree.astro",
    name: "sidebar",
    slot: "Sidebar",
  }),
  layoutComponent({
    description: "The breadcrumb trail shown above page content.",
    file: "Breadcrumbs.astro",
    name: "breadcrumbs",
    slot: "Breadcrumbs",
  }),
  layoutComponent({
    description: "The on-this-page table of contents.",
    file: "TableOfContents.astro",
    name: "table-of-contents",
    slot: "TableOfContents",
  }),
  layoutComponent({
    description: "The previous/next pagination footer.",
    file: "Pagination.astro",
    name: "pagination",
    slot: "Pagination",
  }),
  layoutComponent({
    description: 'The "Was this page helpful?" feedback rating.',
    file: "PageFeedback.astro",
    name: "feedback",
    slot: "Feedback",
  }),
  layoutComponent({
    description:
      "The site footer: a row of links, social icons, the theme toggle, and the Cookie settings link.",
    file: "SiteFooter.astro",
    name: "footer",
    slot: "Footer",
  }),
  ...CONTENT_COMPONENTS.map(contentComponent),
];

export const findItem = (name: string): RegistryItem | undefined =>
  registry.find((item) => item.name === name);
