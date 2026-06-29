import { join } from "pathe";

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
export const packageSrc = join(import.meta.dirname, "..");

/** Absolute path to the bundled registry item sources. */
export const itemsRoot = join(import.meta.dirname, "items");

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

/** The built-in, Blume-owned source registry. */
export const registry: RegistryItem[] = [
  {
    description: "A 'Was this helpful?' feedback widget (static, no server).",
    files: [
      {
        source: "registry/items/feedback/components/blume/Feedback.astro",
        target: "components/blume/Feedback.astro",
      },
    ],
    name: "feedback",
    postInstall: [
      "Register it in components.ts:",
      '  import Feedback from "./components/blume/Feedback.astro";',
      "  export default defineComponents({ mdx: { Feedback } });",
      "Then use <Feedback /> in any MDX page.",
    ],
  },
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
];

export const findItem = (name: string): RegistryItem | undefined =>
  registry.find((item) => item.name === name);
