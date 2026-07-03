import matter from "../../core/frontmatter.ts";
import { stripUnknownPageMeta } from "../shared.ts";
import {
  rewriteMintlifyAccordions,
  rewriteMintlifyCallouts,
  rewriteMintlifyExampleBlocks,
  rewriteSnippetImports,
  unsupportedMintlifyComponents,
} from "./content.ts";
import { normalizeMintlifyPageMeta } from "./frontmatter.ts";
import { rewriteMintlifySvgIconProps } from "./icons.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
  rewriteMintlifyUserVariable,
} from "./snippets.ts";

const USER_REFERENCE = /\{[^{}]*\buser\b/u;

/** The outcome of transforming a single Mintlify page to Blume MDX. */
export interface MintlifyTransformResult {
  /** Component snippet imports kept (rewritten to relative paths). */
  components: string[];
  /** The rewritten file text, including normalized frontmatter. */
  content: string;
  /** Frontmatter keys dropped because Blume has no equivalent. */
  removed: string[];
  /** Components encountered that have no Blume equivalent. */
  unsupported: string[];
}

/**
 * Apply the per-file source transforms that turn Mintlify MDX into Blume MDX:
 * inline snippets and variables, rewrite callouts (`<Note>` → `:::note`),
 * example blocks, and inline-SVG icon props, then normalize frontmatter. Pure
 * text-in/text-out (snippets read from disk relative to `root`), so both the
 * one-shot migrator and the live bridge source share identical behavior.
 */
export const transformMintlifyContent = async (
  raw: string,
  options: { filePath: string; root: string; variables: Record<string, string> }
): Promise<MintlifyTransformResult> => {
  let text = await rewriteMintlifyMarkdownSnippets(raw, {
    filePath: options.filePath,
    root: options.root,
  });
  text = await rewriteMintlifySnippetVariables(text, {
    filePath: options.filePath,
    root: options.root,
  });
  text = rewriteMintlifyGlobalVariables(text, options.variables);
  if (USER_REFERENCE.test(text)) {
    text = rewriteMintlifyUserVariable(text);
  }
  const snippetImports = rewriteSnippetImports(text, {
    filePath: options.filePath,
    root: options.root,
  });
  text = snippetImports.source;
  text = rewriteMintlifySvgIconProps(text);
  text = rewriteMintlifyExampleBlocks(text);
  text = rewriteMintlifyAccordions(text);
  text = rewriteMintlifyCallouts(text);

  const unsupported = unsupportedMintlifyComponents(text);

  const parsed = matter(text);
  const mapped = normalizeMintlifyPageMeta(parsed.data);
  const { data, removed } = stripUnknownPageMeta(mapped);
  const content =
    Object.keys(data).length > 0
      ? matter.stringify(parsed.content, data)
      : parsed.content;

  return {
    components: snippetImports.components,
    content,
    removed,
    unsupported,
  };
};
