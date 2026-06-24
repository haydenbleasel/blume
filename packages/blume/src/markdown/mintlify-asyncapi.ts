import matter from "gray-matter";
import { isAbsolute, relative, resolve } from "pathe";

import {
  parseAsyncApi,
  renderAsyncApiChannelContent,
} from "../asyncapi/import.ts";
import type { AsyncApiDocument } from "../asyncapi/types.ts";

interface MintlifyAsyncApiSpec {
  source: string;
}

interface AsyncApiChannelReference {
  channel: string;
  source?: string;
}

const docsRootRelative = (source: string): boolean => source.startsWith("/");

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const resolveApiSource = (root: string, source: string): string => {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return source;
  }

  const candidate = docsRootRelative(source)
    ? resolve(root, source.slice(1))
    : resolve(root, source);
  return isAbsolute(source) || isInsideRoot(root, candidate)
    ? candidate
    : source;
};

const parseAsyncApiChannelReference = (
  value: unknown
): AsyncApiChannelReference | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  const channel = parts.at(-1);
  if (!channel) {
    return undefined;
  }
  const source = parts.slice(0, -1).join(" ");
  return {
    channel,
    ...(source ? { source } : {}),
  };
};

const findChannelContent = async (
  reference: AsyncApiChannelReference,
  options: {
    root: string;
    specs: MintlifyAsyncApiSpec[];
  }
): Promise<string | undefined> => {
  const sources = reference.source
    ? [reference.source]
    : options.specs.map((spec) => spec.source);
  const contents = await Promise.all(
    sources.map(async (source) => {
      try {
        const doc: AsyncApiDocument = await parseAsyncApi(
          resolveApiSource(options.root, source)
        );
        return renderAsyncApiChannelContent(doc, reference.channel);
      } catch {
        // Ignore invalid candidate specs while searching for the channel.
      }
    })
  );
  return contents.find((content): content is string => content !== undefined);
};

/** Expand Mintlify `asyncapi` frontmatter pages with generated channel content. */
export const rewriteMintlifyAsyncApiPage = async (
  source: string,
  options: {
    root: string;
    specs: MintlifyAsyncApiSpec[];
  }
): Promise<string> => {
  const parsed = matter(source);
  const reference = parseAsyncApiChannelReference(parsed.data.asyncapi);
  if (!reference) {
    return source;
  }

  const content = await findChannelContent(reference, options);
  return content ? `${source.trimEnd()}\n\n${content}` : source;
};
