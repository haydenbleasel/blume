import matter from "gray-matter";
import { isAbsolute, relative, resolve } from "pathe";

import {
  parseOpenApi,
  renderOpenApiOperationContent,
  renderOpenApiSchemaContent,
} from "../openapi/import.ts";
import type { OpenApiGenerationOptions } from "../openapi/import.ts";
import { HTTP_METHODS } from "../openapi/types.ts";
import type { OpenApiDocument } from "../openapi/types.ts";

interface MintlifyOpenApiSpec {
  source: string;
}

interface OpenApiSchemaReference {
  schema: string;
  source?: string;
}

interface OpenApiOperationReference {
  method: string;
  path: string;
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

const parseOpenApiSchemaReference = (
  value: unknown
): OpenApiSchemaReference | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length === 1) {
    return { schema: parts[0] ?? "" };
  }
  const schema = parts.at(-1);
  return schema ? { schema, source: parts.slice(0, -1).join(" ") } : undefined;
};

const parseOpenApiOperationReference = (
  value: unknown
): OpenApiOperationReference | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  const methodIndex = parts.findIndex(
    (part) =>
      part.toLowerCase() === "webhook" ||
      HTTP_METHODS.includes(part.toLowerCase() as (typeof HTTP_METHODS)[number])
  );
  if (methodIndex === -1) {
    return undefined;
  }
  const method = parts[methodIndex];
  const path = parts.slice(methodIndex + 1).join(" ");
  if (!method || !path) {
    return undefined;
  }
  const source = parts.slice(0, methodIndex).join(" ");
  return {
    method,
    path,
    ...(source ? { source } : {}),
  };
};

const findSchemaDoc = async (
  reference: OpenApiSchemaReference,
  options: {
    root: string;
    specs: MintlifyOpenApiSpec[];
  }
): Promise<OpenApiDocument | undefined> => {
  const sources = reference.source
    ? [reference.source]
    : options.specs.map((spec) => spec.source);
  const docs = await Promise.all(
    sources.map(async (source) => {
      try {
        const doc = await parseOpenApi(resolveApiSource(options.root, source));
        return doc.components?.schemas?.[reference.schema] ? doc : undefined;
      } catch {
        // Ignore invalid candidate specs while searching for the schema.
      }
    })
  );
  return docs.find((doc): doc is OpenApiDocument => doc !== undefined);
};

const findOperationContent = async (
  reference: OpenApiOperationReference,
  options: {
    generation: OpenApiGenerationOptions;
    root: string;
    specs: MintlifyOpenApiSpec[];
  }
): Promise<string | undefined> => {
  const sources = reference.source
    ? [reference.source]
    : options.specs.map((spec) => spec.source);
  const contents = await Promise.all(
    sources.map(async (source) => {
      try {
        const doc = await parseOpenApi(resolveApiSource(options.root, source));
        return renderOpenApiOperationContent(
          doc,
          reference.method,
          reference.path,
          options.generation
        );
      } catch {
        // Ignore invalid candidate specs while searching for the operation.
      }
    })
  );
  return contents.find((content): content is string => content !== undefined);
};

export const rewriteMintlifyOpenApiSchemaPage = async (
  source: string,
  options: {
    filePath: string;
    generation?: OpenApiGenerationOptions;
    root: string;
    specs: MintlifyOpenApiSpec[];
  }
): Promise<string> => {
  const parsed = matter(source);
  const operationReference = parseOpenApiOperationReference(
    parsed.data.openapi
  );
  if (operationReference) {
    const content = await findOperationContent(operationReference, {
      generation: options.generation ?? {},
      root: options.root,
      specs: options.specs,
    });
    if (content) {
      return `${source.trimEnd()}\n\n${content}`;
    }
  }

  const reference = parseOpenApiSchemaReference(parsed.data["openapi-schema"]);
  if (!reference?.schema) {
    return source;
  }

  const doc = await findSchemaDoc(reference, options);
  if (!doc) {
    return source;
  }

  const hasBody = parsed.content.trim().length > 0;
  const hasTitle = typeof parsed.data.title === "string";
  const content = renderOpenApiSchemaContent(doc, reference.schema, {
    headingDepth: hasBody || hasTitle ? 2 : 1,
  });
  return content ? `${source.trimEnd()}\n\n${content}` : source;
};
