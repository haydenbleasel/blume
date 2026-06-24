import { readFile as readFileFromDisk } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, relative, resolve } from "pathe";

const MARKDOWN_SNIPPET_IMPORT =
  /^import\s+(?<name>[$A-Z_a-z][$\w]*)\s+from\s+["'](?<source>[^"']+\.mdx?)["'];?\s*$/gmu;
const NAMED_SNIPPET_IMPORT =
  /^import\s+\{(?<names>[^}]+)\}\s+from\s+["'](?<source>[^"']+\.mdx?)["'];?\s*$/gmu;
const EXPORTED_STRING_CONST =
  /^export\s+const\s+(?<name>[$A-Z_a-z][$\w]*)\s*=\s*(?:"(?<double>(?:\\.|[^"\\])*)"|'(?<single>(?:\\.|[^'\\])*)'|`(?<template>(?:\\.|[^`\\])*)`)\s*;?\s*$/gmu;
const ATTRIBUTE =
  /\s+(?<name>[$A-Z_a-z][$\w:-]*)(?:=(?:"(?<quoted>[^"]*)"|'(?<single>[^']*)'|\{(?<expression>[^}]*)\}))?/gu;
const PLACEHOLDER = /\{(?<name>[$A-Z_a-z][$\w]*)\}/gu;
const GLOBAL_VARIABLE = /\{\{\s*(?<name>[A-Za-z0-9-]+)\s*\}\}/gu;
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;
const USER_EXPORT =
  /^(?:export\s+)?(?:const|let|var)\s+user\s*=|^import\s+\{\s*user\s*\}/mu;

interface SnippetImport {
  importText: string;
  name: string;
  source: string;
}

interface SnippetVariableImport {
  names: { imported: string; local: string }[];
  source: string;
}

interface SnippetTransformOptions {
  filePath: string;
  root: string;
  readFile?: (file: string) => Promise<string>;
  seen?: Set<string>;
  trail?: string[];
}

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const snippetSelfClosingTagPattern = (name: string): RegExp =>
  new RegExp(`<${escapeRegExp(name)}(?<attrs>[^>]*?)\\s*/>`, "gu");

const snippetPairedTagPattern = (name: string): RegExp =>
  new RegExp(
    `<${escapeRegExp(name)}(?<attrs>[^>]*?)>[\\s\\S]*?</${escapeRegExp(name)}>`,
    "gu"
  );

const rootRelativePath = (root: string, file: string): string => {
  const rel = relative(root, file);
  return rel ? `/${rel}` : "/";
};

const snippetCycleMessage = (
  root: string,
  file: string,
  trail: string[]
): string => {
  const cycleStart = trail.indexOf(file);
  const cycle = [...(cycleStart === -1 ? trail : trail.slice(cycleStart)), file]
    .map((entry) => rootRelativePath(root, entry))
    .join(" -> ");
  return `Circular Mintlify snippet import detected: ${cycle}`;
};

const resolveSnippetPath = (options: {
  filePath: string;
  root: string;
  source: string;
}): string | null => {
  const target = options.source.startsWith("/")
    ? resolve(options.root, options.source.slice(1))
    : resolve(dirname(options.filePath), options.source);
  return isInsideRoot(options.root, target) ? target : null;
};

const collectImports = (source: string): SnippetImport[] =>
  [...source.matchAll(MARKDOWN_SNIPPET_IMPORT)].flatMap((match) => {
    const name = match.groups?.name;
    const importSource = match.groups?.source;
    if (!(name && importSource)) {
      return [];
    }
    return [{ importText: match[0], name, source: importSource }];
  });

const collectVariableImports = (source: string): SnippetVariableImport[] =>
  [...source.matchAll(NAMED_SNIPPET_IMPORT)].flatMap((match) => {
    const names = match.groups?.names;
    const importSource = match.groups?.source;
    if (!(names && importSource)) {
      return [];
    }
    const parsedNames = names.split(",").flatMap((entry) => {
      const [imported, local] = entry.trim().split(/\s+as\s+/u);
      return imported ? [{ imported, local: local ?? imported }] : [];
    });
    return parsedNames.length
      ? [{ names: parsedNames, source: importSource }]
      : [];
  });

const decodeStringLiteral = (value: string): string =>
  value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll(/\\(?<escaped>[\\'"`])/gu, "$<escaped>");

const collectStringExports = (source: string): Map<string, string> => {
  const exports = new Map<string, string>();
  for (const match of source.matchAll(EXPORTED_STRING_CONST)) {
    const name = match.groups?.name;
    const value =
      match.groups?.double ?? match.groups?.single ?? match.groups?.template;
    if (name && value !== undefined) {
      exports.set(name, decodeStringLiteral(value));
    }
  }
  return exports;
};

const parseAttributes = (source: string): Record<string, string> => {
  const props: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match.groups?.name;
    if (!name) {
      continue;
    }
    props[name] =
      match.groups?.quoted ??
      match.groups?.single ??
      match.groups?.expression?.trim() ??
      "true";
  }
  return props;
};

const interpolateProps = (
  source: string,
  props: Record<string, string>
): string =>
  source.replaceAll(PLACEHOLDER, (value, name: string) => props[name] ?? value);

const stripImport = (source: string, importText: string): string =>
  source.replace(importText, "").replaceAll(/\n{3,}/gu, "\n\n");

const replacePlaceholder = (
  source: string,
  name: string,
  value: string
): string =>
  source.replaceAll(new RegExp(`\\{${escapeRegExp(name)}\\}`, "gu"), value);

const inlineSnippetTags = (options: {
  name: string;
  snippet: string;
  source: string;
}): string => {
  const inline = (_value: string, attrs: string): string =>
    interpolateProps(options.snippet, parseAttributes(attrs));
  return options.source
    .replaceAll(snippetSelfClosingTagPattern(options.name), inline)
    .replaceAll(snippetPairedTagPattern(options.name), inline);
};

/**
 * Mintlify markdown snippets are source-level includes, not standalone pages.
 * Inline markdown snippets before Astro MDX compiles so `.md` imports, nested
 * markdown snippets, and `{prop}` interpolation inside prose or code fences work.
 */
export const rewriteMintlifyMarkdownSnippets = async (
  source: string,
  options: SnippetTransformOptions
): Promise<string> => {
  const loadSnippet = async (file: string): Promise<string> => {
    const seen = options.seen ?? new Set<string>();
    if (seen.has(file)) {
      throw new Error(
        snippetCycleMessage(options.root, file, options.trail ?? [])
      );
    }
    seen.add(file);
    const readFile = options.readFile ?? readFileFromDisk;
    try {
      const raw = await readFile(file);
      const content = matter(raw).content.trim();
      const transformed = await rewriteMintlifyMarkdownSnippets(content, {
        ...options,
        filePath: file,
        seen,
        trail: [...(options.trail ?? []), file],
      });
      return transformed.trim();
    } finally {
      seen.delete(file);
    }
  };

  const inlineImport = async (
    current: string,
    snippetImport: SnippetImport
  ): Promise<string> => {
    const file = resolveSnippetPath({
      filePath: options.filePath,
      root: options.root,
      source: snippetImport.source,
    });
    if (!file) {
      return current;
    }

    const snippet = await loadSnippet(file);
    const next = inlineSnippetTags({
      name: snippetImport.name,
      snippet,
      source: current,
    });
    return next === current
      ? current
      : stripImport(next, snippetImport.importText);
  };

  const imports = collectImports(source);
  const inlineAt = async (index: number, current: string): Promise<string> => {
    const snippetImport = imports[index];
    if (!snippetImport) {
      return current;
    }
    return inlineAt(index + 1, await inlineImport(current, snippetImport));
  };

  return await inlineAt(0, source);
};

/** Resolve imported string constants from Mintlify snippets for generated text. */
export const rewriteMintlifySnippetVariables = async (
  source: string,
  options: SnippetTransformOptions
): Promise<string> => {
  const readFile = options.readFile ?? readFileFromDisk;
  const inlineImport = async (
    current: string,
    variableImport: SnippetVariableImport
  ): Promise<string> => {
    const file = resolveSnippetPath({
      filePath: options.filePath,
      root: options.root,
      source: variableImport.source,
    });
    if (!file) {
      return current;
    }

    const exports = collectStringExports(matter(await readFile(file)).content);
    let next = current;
    for (const name of variableImport.names) {
      const value = exports.get(name.imported);
      if (value !== undefined) {
        next = replacePlaceholder(next, name.local, value);
      }
    }
    return next;
  };

  const imports = collectVariableImports(source);
  const inlineAt = async (index: number, current: string): Promise<string> => {
    const variableImport = imports[index];
    if (!variableImport) {
      return current;
    }
    return inlineAt(index + 1, await inlineImport(current, variableImport));
  };

  return await inlineAt(0, source);
};

/** Replace docs.json Mintlify globals such as `{{product-name}}`. */
export const rewriteMintlifyGlobalVariables = (
  source: string,
  variables: Record<string, string>
): string =>
  source.replaceAll(GLOBAL_VARIABLE, (value, name: string) =>
    Object.hasOwn(variables, name) ? (variables[name] ?? value) : value
  );

/** Mintlify exposes a logged-out `user` object to MDX personalization code. */
export const rewriteMintlifyUserVariable = (source: string): string => {
  if (USER_EXPORT.test(source)) {
    return source;
  }

  const frontmatter = source.match(FRONTMATTER_BLOCK)?.[0] ?? "";
  const body = (
    frontmatter ? source.slice(frontmatter.length) : source
  ).replace(/^\r?\n/u, "");
  return `${frontmatter}export const user = {};\n\n${body}`;
};
