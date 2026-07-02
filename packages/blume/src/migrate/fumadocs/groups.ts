import { existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";

import { basename, join } from "pathe";

import { isInsideRoot } from "../shared.ts";
import { renderMetaModule } from "./meta.ts";
import type {
  FumadocsPageItem,
  FumadocsPagesStructure,
  FumadocsSection,
} from "./meta.ts";

/**
 * Rebuild Fumadocs `---Section---` separators as Blume group folders.
 *
 * Fumadocs draws a non-collapsible section heading from a `"---Label---"` entry
 * in a folder's `pages` array — exactly what a Blume `(Label)/` group folder
 * renders by default (`display: "flat"`). Blume has no flat-file "separator"
 * primitive, so the only faithful, non-overriding home for a section is a group
 * folder: it is route-transparent (the `(Label)` segment is stripped from URLs,
 * see `core/sources/normalize.ts`) and composes with per-folder `meta.ts`,
 * unlike a global `navigation.sidebar` override (which would disable every other
 * folder's meta site-wide).
 *
 * The reshape runs against the already-migrated `docs/` tree, so each `pages`
 * entry is resolved to a real page file or folder before it is moved. A section
 * that is a single folder is left in place (wrapping it would double the
 * heading); links have no file to move and are dropped with a warning.
 */

const PAGE_EXTS = [".mdx", ".md"];
const WORD_SPLIT = /[-_]/u;
const PATH_SEP = /[/\\]/u;

interface ResolvedEntry {
  kind: "file" | "folder";
  path: string;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Resolve a `pages` name to its on-disk page file or folder under `docsDir`. */
const resolveEntry = (docsDir: string, name: string): ResolvedEntry | null => {
  // A `pages` entry is author-controlled; reject any that escapes `docsDir`
  // (e.g. `"../../victim"`) so the later `rename` can't move a file out of the
  // docs tree.
  if (!isInsideRoot(docsDir, join(docsDir, name))) {
    return null;
  }
  for (const ext of PAGE_EXTS) {
    const file = join(docsDir, `${name}${ext}`);
    if (existsSync(file)) {
      return { kind: "file", path: file };
    }
  }
  const folder = join(docsDir, name);
  return isDirectory(folder) ? { kind: "folder", path: folder } : null;
};

const humanize = (name: string): string =>
  name
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const linkWarning = (item: { href: string; text: string }): string =>
  `Dropped sidebar link "${item.text}" (${item.href}) — add it to navbar.links manually.`;

const extractWarning = (name: string): string =>
  `Sidebar extract "...${name}" became a normal "${name}" group (its pages are not flattened into the parent).`;

export interface GroupReshapeResult {
  /** Ordering keys for the parent folder's `meta.ts` `pages`. */
  order: string[];
  warnings: string[];
}

/** Record an in-place item's ordering key (lead items, or an ungroupable run). */
const addUngroupedItem = (
  item: FumadocsPageItem,
  order: string[],
  warnings: string[]
): void => {
  if (item.kind === "link") {
    warnings.push(linkWarning(item));
    return;
  }
  if (item.kind === "extract") {
    warnings.push(extractWarning(item.name));
  }
  order.push(item.name);
};

/** A section of one folder keeps its place without a wrapping group folder. */
const reshapeSingleFolderSection = (
  section: FumadocsSection,
  only: FumadocsPageItem & { kind: "extract" | "ref" },
  order: string[],
  warnings: string[]
): void => {
  order.push(only.name);
  if (humanize(only.name).toLowerCase() !== section.label.toLowerCase()) {
    warnings.push(
      `Section "${section.label}" wraps folder "${only.name}"; set that folder's meta title to "${section.label}" to make the heading match.`
    );
  }
  if (only.kind === "extract") {
    warnings.push(extractWarning(only.name));
  }
};

/** Move one section item into the group folder; return its ordering key. */
const moveItemIntoGroup = async (
  item: FumadocsPageItem,
  docsDir: string,
  groupDir: string,
  label: string,
  warnings: string[]
): Promise<string | null> => {
  if (item.kind === "link") {
    warnings.push(linkWarning(item));
    return null;
  }
  const resolved = resolveEntry(docsDir, item.name);
  if (!resolved) {
    warnings.push(
      `Sidebar entry "${item.name}" in section "${label}" matched no page or folder; skipped.`
    );
    return null;
  }
  const dest = join(groupDir, basename(resolved.path));
  if (existsSync(dest)) {
    warnings.push(
      `Skipped moving "${item.name}" into section "${label}" (target already exists).`
    );
    return null;
  }
  await mkdir(groupDir, { recursive: true });
  await rename(resolved.path, dest);
  if (item.kind === "extract") {
    warnings.push(extractWarning(item.name));
  }
  return item.name;
};

const reshapeSection = async (
  section: FumadocsSection,
  docsDir: string,
  order: string[],
  warnings: string[]
): Promise<void> => {
  const movable = section.items.filter((item) => item.kind !== "link");

  // A lone folder already renders as its own group; wrapping it in a `(Label)/`
  // folder would stack two headings, so leave it in place.
  if (movable.length === 1) {
    const [only] = movable as [FumadocsPageItem & { kind: "extract" | "ref" }];
    if (resolveEntry(docsDir, only.name)?.kind === "folder") {
      reshapeSingleFolderSection(section, only, order, warnings);
      return;
    }
  }

  if (PATH_SEP.test(section.label)) {
    warnings.push(
      `Section "${section.label}" has a slash in its name and can't become a group folder; its pages stay ungrouped.`
    );
    for (const item of section.items) {
      addUngroupedItem(item, order, warnings);
    }
    return;
  }

  const groupDir = join(docsDir, `(${section.label})`);
  const sectionKeys: string[] = [];
  for (const item of section.items) {
    // oxlint-disable-next-line no-await-in-loop -- sequential moves into one group
    const key = await moveItemIntoGroup(
      item,
      docsDir,
      groupDir,
      section.label,
      warnings
    );
    if (key) {
      sectionKeys.push(key);
    }
  }

  // Nothing movable (e.g. a link-only section) — drop the empty heading.
  if (sectionKeys.length === 0) {
    return;
  }

  // The group folder's key in the nav is its label, so order it by label.
  order.push(section.label);
  // Preserve the authored order of the section's pages.
  if (sectionKeys.length > 1) {
    await writeFile(
      join(groupDir, "meta.ts"),
      renderMetaModule({ pages: sectionKeys }),
      "utf-8"
    );
  }
};

/**
 * Reshape a parsed `pages` structure into group folders under `docsDir`,
 * returning the parent folder's `meta.ts` page ordering and any warnings. Items
 * are moved within the already-migrated `docs/` tree, so this must run after the
 * pages have been moved out of `content/docs`.
 */
export const reshapeFumadocsGroups = async (
  structure: FumadocsPagesStructure,
  docsDir: string
): Promise<GroupReshapeResult> => {
  const order: string[] = [];
  const warnings: string[] = [];

  for (const item of structure.lead) {
    addUngroupedItem(item, order, warnings);
  }
  for (const section of structure.sections) {
    // oxlint-disable-next-line no-await-in-loop -- sections share `docsDir` state
    await reshapeSection(section, docsDir, order, warnings);
  }

  return { order, warnings };
};
