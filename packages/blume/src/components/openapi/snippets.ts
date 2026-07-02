import { exampleValue, toJson } from "./helpers.ts";
import type { SchemaLike } from "./helpers.ts";

/**
 * Request example + code-sample generation for an operation. Kept separate from
 * `helpers.ts` so the schema renderers don't pull in the sample builders. Output
 * is intentionally simple, copy-pasteable starter code — not an exhaustive SDK.
 */

interface ParamLike {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: SchemaLike;
  example?: unknown;
}

interface MediaTypeLike {
  schema?: SchemaLike;
  example?: unknown;
}

export interface OperationLike {
  parameters?: ParamLike[];
  requestBody?: { content?: Record<string, MediaTypeLike> };
}

export interface RequestSample {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON-stringified request body, when the operation takes one. */
  body?: string;
  bodyValue?: unknown;
}

const TRAILING_SLASH = /\/+$/u;

const jsonContentType = (
  content: Record<string, MediaTypeLike> | undefined
): [string, MediaTypeLike] | undefined => {
  const entries = Object.entries(content ?? {});
  return entries.find(([type]) => type.includes("json")) ?? entries[0];
};

/** Assemble a representative request from an operation and the spec servers. */
export const buildRequestSample = (
  operation: OperationLike,
  method: string,
  path: string,
  servers: { url?: string }[],
  schemas: Record<string, SchemaLike>
): RequestSample => {
  const base = (servers[0]?.url ?? "").replace(TRAILING_SLASH, "");
  const params = operation.parameters ?? [];

  let resolvedPath = path;
  for (const param of params) {
    if (param.in === "path" && param.name) {
      const value = param.example ?? exampleValue(param.schema, schemas);
      resolvedPath = resolvedPath.replace(
        `{${param.name}}`,
        encodeURIComponent(String(value ?? param.name))
      );
    }
  }

  const query = params
    .filter((param) => param.in === "query" && param.required && param.name)
    .map((param) => {
      const value = param.example ?? exampleValue(param.schema, schemas);
      return `${encodeURIComponent(param.name ?? "")}=${encodeURIComponent(
        String(value ?? "")
      )}`;
    });
  const search = query.length > 0 ? `?${query.join("&")}` : "";

  const headers: Record<string, string> = {};
  for (const param of params) {
    if (param.in === "header" && param.required && param.name) {
      headers[param.name] = String(
        param.example ?? exampleValue(param.schema, schemas) ?? ""
      );
    }
  }

  const media = jsonContentType(operation.requestBody?.content);
  let body: string | undefined;
  let bodyValue: unknown;
  if (media) {
    const [type, mediaType] = media;
    headers["Content-Type"] = type;
    bodyValue = mediaType.example ?? exampleValue(mediaType.schema, schemas);
    body = toJson(bodyValue);
  }

  return {
    body,
    bodyValue,
    headers,
    method: method.toUpperCase(),
    url: `${base}${resolvedPath}${search}`,
  };
};

const headerLines = (
  headers: Record<string, string>,
  format: (key: string, value: string) => string
): string[] =>
  Object.entries(headers).map(([key, value]) => format(key, value));

const curlSnippet = (sample: RequestSample): string => {
  const lines = [
    `curl -X ${sample.method} "${sample.url}"`,
    ...headerLines(sample.headers, (key, value) => `  -H "${key}: ${value}"`),
  ];
  if (sample.body) {
    lines.push(`  -d '${sample.body}'`);
  }
  return lines.join(" \\\n");
};

const fetchSnippet = (sample: RequestSample): string => {
  const options = [`  method: "${sample.method}"`];
  if (Object.keys(sample.headers).length > 0) {
    const headers = headerLines(
      sample.headers,
      (key, value) => `    "${key}": "${value}"`
    ).join(",\n");
    options.push(`  headers: {\n${headers}\n  }`);
  }
  if (sample.body) {
    options.push(`  body: JSON.stringify(${sample.body})`);
  }
  return `const response = await fetch("${sample.url}", {\n${options.join(
    ",\n"
  )}\n});`;
};

/** Turn a JSON literal into an equivalent Python literal (`true` -> `True`). */
const toPython = (json: string): string =>
  json
    .replaceAll(/\btrue\b/gu, "True")
    .replaceAll(/\bfalse\b/gu, "False")
    .replaceAll(/\bnull\b/gu, "None");

const pythonSnippet = (sample: RequestSample): string => {
  const args = [`    "${sample.url}"`];
  if (Object.keys(sample.headers).length > 0) {
    const headers = headerLines(
      sample.headers,
      (key, value) => `        "${key}": "${value}"`
    ).join(",\n");
    args.push(`    headers={\n${headers}\n    }`);
  }
  if (sample.body) {
    args.push(`    json=${toPython(sample.body)}`);
  }
  return `import requests\n\nresponse = requests.${sample.method.toLowerCase()}(\n${args.join(
    ",\n"
  )},\n)`;
};

/** A code-sample language: config id -> label, Shiki lang, and builder. */
export interface SampleLanguage {
  id: string;
  label: string;
  lang: string;
  build: (sample: RequestSample) => string;
}

const LANGUAGES: SampleLanguage[] = [
  { build: curlSnippet, id: "curl", label: "cURL", lang: "bash" },
  { build: fetchSnippet, id: "js", label: "JavaScript", lang: "js" },
  { build: pythonSnippet, id: "python", label: "Python", lang: "python" },
];

const ALIASES: Record<string, string> = {
  bash: "curl",
  javascript: "js",
  node: "js",
  py: "python",
  shell: "curl",
  typescript: "js",
};

/** The sample languages to render, resolved from config ids (unknown ids dropped). */
export const sampleLanguages = (ids: string[]): SampleLanguage[] => {
  const wanted = ids.length > 0 ? ids : ["curl", "js", "python"];
  const out: SampleLanguage[] = [];
  const seen = new Set<string>();
  for (const raw of wanted) {
    const id = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
    const language = LANGUAGES.find((entry) => entry.id === id);
    if (language && !seen.has(id)) {
      seen.add(id);
      out.push(language);
    }
  }
  return out;
};
