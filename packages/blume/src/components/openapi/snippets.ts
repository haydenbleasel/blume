import { exampleValue, toJson } from "./helpers.ts";
import type { SchemaLike } from "./helpers.ts";
import type { SampleAuth } from "./security.ts";

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

/**
 * The `?a=1&b=2` query string from an operation's required query params, plus
 * any extra entries (a query-borne API key from the security requirements).
 */
const queryString = (
  params: ParamLike[],
  schemas: Record<string, SchemaLike>,
  extra: Record<string, string>
): string => {
  const query: string[] = [];
  for (const param of params) {
    if (!(param.in === "query" && param.required && param.name)) {
      continue;
    }
    const value = param.example ?? exampleValue(param.schema, schemas);
    query.push(
      `${encodeURIComponent(param.name)}=${encodeURIComponent(
        String(value ?? "")
      )}`
    );
  }
  for (const [name, value] of Object.entries(extra)) {
    query.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return query.length > 0 ? `?${query.join("&")}` : "";
};

/**
 * The sample's headers: auth placeholders first, so a spec that also declares
 * the credential as an explicit header parameter overrides them with its own
 * (better) example.
 */
const headerValues = (
  params: ParamLike[],
  schemas: Record<string, SchemaLike>,
  auth: SampleAuth | undefined
): Record<string, string> => {
  const headers: Record<string, string> = { ...auth?.headers };
  for (const param of params) {
    if (param.in === "header" && param.required && param.name) {
      headers[param.name] = String(
        param.example ?? exampleValue(param.schema, schemas) ?? ""
      );
    }
  }
  return headers;
};

/** Assemble a representative request from an operation and the spec servers. */
export const buildRequestSample = (
  operation: OperationLike,
  method: string,
  path: string,
  servers: { url?: string }[],
  schemas: Record<string, SchemaLike>,
  auth?: SampleAuth
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

  const search = queryString(params, schemas, auth?.query ?? {});
  const headers = headerValues(params, schemas, auth);

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
    // Close-quote/escaped-quote/reopen: the POSIX way to put a literal ' in a
    // single-quoted string, so an example like "it's" doesn't break the shell.
    const escapedBody = sample.body.replaceAll("'", String.raw`'\''`);
    lines.push(`  -d '${escapedBody}'`);
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

// Split-with-capture: odd segments are JSON string literals, kept verbatim so
// a string *value* containing the words true/false/null isn't rewritten.
const JSON_STRING = /(?<literal>"(?:\\.|[^"\\])*")/gu;

/** Turn a JSON literal into an equivalent Python literal (`true` -> `True`). */
const toPython = (json: string): string =>
  json
    .split(JSON_STRING)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replaceAll(/\btrue\b/gu, "True")
            .replaceAll(/\bfalse\b/gu, "False")
            .replaceAll(/\bnull\b/gu, "None")
    )
    .join("");

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
  const byId = new Map(LANGUAGES.map((entry) => [entry.id, entry]));
  const out: SampleLanguage[] = [];
  const seen = new Set<string>();
  for (const raw of wanted) {
    const id = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
    const language = byId.get(id);
    if (language && !seen.has(id)) {
      seen.add(id);
      out.push(language);
    }
  }
  return out;
};
