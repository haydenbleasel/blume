import { dirname, join, relative } from "pathe";

import { rewriteCallouts } from "../shared.ts";

/**
 * Source-to-source rewrites that turn Mintlify-only MDX component syntax into
 * idiomatic Blume markup. Runs once at migration time — no Mintlify-aware
 * plugins remain in the Blume runtime.
 */

/** Mintlify callout components mapped to Blume directive names. */
const CALLOUT_DIRECTIVES: Record<string, string> = {
  Check: "success",
  Danger: "danger",
  Error: "danger",
  Info: "info",
  Note: "note",
  Success: "success",
  Tip: "tip",
  Warning: "warning",
};

/** `<Callout type="X">` values mapped to Blume directive names. */
const CALLOUT_TYPE_DIRECTIVES: Record<string, string> = {
  caution: "warning",
  check: "success",
  danger: "danger",
  error: "danger",
  info: "info",
  note: "note",
  success: "success",
  tip: "tip",
  warning: "warning",
};

/**
 * Convert Mintlify callout components (`<Note>`, `<Warning>`, `<Callout
 * type="…">`, …) into Blume `:::` directives.
 */
export const rewriteMintlifyCallouts = (source: string): string =>
  rewriteCallouts(source, {
    defaultDirective: "note",
    tagDirectives: CALLOUT_DIRECTIVES,
    tags: ["Callout", ...Object.keys(CALLOUT_DIRECTIVES)],
    typeDirectives: CALLOUT_TYPE_DIRECTIVES,
  });

/**
 * Mintlify's `<RequestExample>`/`<ResponseExample>` are tab-style code wrappers
 * with no Blume equivalent; rename them to `<CodeGroup>`, which renders the
 * same titled-fence tabs.
 */
export const rewriteMintlifyExampleBlocks = (source: string): string =>
  source.replaceAll(
    /<(?<close>\/?)(?:Request|Response)Example\b/gu,
    "<$<close>CodeGroup"
  );

/**
 * Mintlify nests `<Accordion title="…">` items inside an `<AccordionGroup>`.
 * Blume inverts that: `<Accordion>` is the container and each item is an
 * `<AccordionItem title="…">`. Rewrite both in a single pass — the `\b` after
 * `Accordion` keeps `<AccordionGroup>` (the `Group` branch) distinct from an
 * item, so open/close tags of either map correctly regardless of order. Without
 * this, migrated pages keep `<AccordionGroup>`, which Blume doesn't ship and the
 * MDX build rejects with "Expected component AccordionGroup to be defined".
 */
export const rewriteMintlifyAccordions = (source: string): string =>
  source.replaceAll(
    /<(?<close>\/?)Accordion(?<group>Group)?\b/gu,
    (_match, close: string, group: string | undefined) =>
      group ? `<${close}Accordion` : `<${close}AccordionItem`
  );

const SNIPPET_IMPORT =
  /^import\s+[\s\S]*?\s+from\s+["'](?<source>\/snippets\/[^"']+)["'];?[ \t]*\n?/gmu;

/**
 * After snippets are inlined, clean up leftover `/snippets/*` imports: drop the
 * now-dead markdown imports, and rewrite component imports (`.jsx`/`.tsx`/…) to
 * a path relative to the page so they still resolve once `/snippets` content is
 * gone. Returns the rewritten source and the component files still referenced.
 */
export const rewriteSnippetImports = (
  source: string,
  options: { filePath: string; root: string }
): { components: string[]; source: string } => {
  const components: string[] = [];
  const next = source.replaceAll(
    SNIPPET_IMPORT,
    (match, importSource: string) => {
      if (/\.mdx?$/u.test(importSource)) {
        return "";
      }
      const target = join(options.root, importSource.replace(/^\/+/u, ""));
      components.push(importSource.replace(/^\/+/u, ""));
      let rel = relative(dirname(options.filePath), target);
      if (!rel.startsWith(".")) {
        rel = `./${rel}`;
      }
      return match.replace(importSource, rel);
    }
  );
  return { components, source: next };
};

/**
 * Component tags Blume has no equivalent for — reported for manual review.
 * `<ParamField>`/`<ResponseField>`/`<RequestField>` are no longer here: Blume
 * ships compat components for them, so migrated docs render as-is. Mintlify's
 * `<Update>` changelog entry has no component form in Blume (changelog is
 * frontmatter-driven via `type: changelog`), so it stays flagged.
 */
const UNSUPPORTED_COMPONENTS = ["Update"];

/** Names of Mintlify components in `source` that need manual attention. */
export const unsupportedMintlifyComponents = (source: string): string[] =>
  UNSUPPORTED_COMPONENTS.filter((name) =>
    new RegExp(`<${name}\\b`, "u").test(source)
  );
