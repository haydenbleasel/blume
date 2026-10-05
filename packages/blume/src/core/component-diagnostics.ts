import { relative } from "pathe";

import { BUILTIN_MDX_TAGS } from "./builtin-tags.ts";
import type { Diagnostic, PageRecord } from "./types.ts";

/** `CardGroup` → `card-group`, matching registry item names. */
const toKebab = (tag: string): string =>
  tag
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();

/**
 * Warn when an `.mdx` page uses a `<Component>` tag that resolves to nothing —
 * a built-in, an island, or a `components.ts` override — so a typo surfaces as a
 * friendly diagnostic (with a `blume add` hint where one exists) instead of a raw
 * MDX "X is not defined" build error. `extraTags` are the project's own known
 * components (islands + overrides); `registryNames` gates the install hint.
 */
export const validateUsedComponents = (
  pages: PageRecord[],
  extraTags: Set<string>,
  registryNames: Set<string>
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const tag of page.componentsUsed ?? []) {
      if (BUILTIN_MDX_TAGS.has(tag) || extraTags.has(tag) || seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      const name = toKebab(tag);
      const suggestion = registryNames.has(name)
        ? `Run \`blume add ${name}\` to install it, or register <${tag}> in components.ts (mdx).`
        : `Register <${tag}> in components.ts (mdx), or add an islands/${tag}.tsx component.`;
      diagnostics.push({
        code: "BLUME_UNKNOWN_COMPONENT",
        file: page.sourcePath ?? page.id,
        message: `<${tag}> is used in ${page.route} but isn't a known component.`,
        severity: "warning",
        suggestion,
      });
    }
  }
  return diagnostics;
};

/** What example discovery found: where it looked, and each example's key. */
export interface ExampleKeys {
  /** Absolute directory the examples were discovered under. */
  dir: string;
  examples: readonly { path: string }[];
}

/**
 * Warn about each `<Component path>` in an `.mdx` page that names no
 * discovered example. The page still renders, with a "No example found" box
 * where the preview should be, so without this a typo or a moved example
 * ships silently. Reported at the `path` value, in the partial that holds it
 * when an `<include>` brought it in; a file shared by several locales is
 * reported once. `extraTags` are the project's own components (islands +
 * overrides), as for {@link validateUsedComponents}: one named `Component`
 * replaces the built-in and resolves `path` its own way, so none is checked.
 */
export const missingExampleDiagnostics = (
  pages: readonly PageRecord[],
  discovery: ExampleKeys,
  root: string,
  extraTags: ReadonlySet<string>
): Diagnostic[] => {
  if (extraTags.has("Component")) {
    return [];
  }
  const known = new Set(discovery.examples.map((example) => example.path));
  const dir = relative(root, discovery.dir) || ".";
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const use of page.examplesUsed ?? []) {
      const file = use.file ?? page.sourcePath ?? page.id;
      const key = `${file}:${use.line}:${use.column}`;
      if (!(known.has(use.path) || seen.has(key))) {
        seen.add(key);
        diagnostics.push({
          code: "BLUME_EXAMPLE_NOT_FOUND",
          column: use.column,
          file,
          line: use.line,
          message: `<Component path="${use.path}"> in ${page.route} names no example, so the page shows "No example found" in its place.`,
          severity: "warning",
          suggestion: `Fix the path, or add the example under ${dir}/: \`path\` is its location there, without the extension.`,
        });
      }
    }
  }
  return diagnostics;
};
