/**
 * Code-sample generation for an operation. Deliberately dependency-free: the
 * playground client renders samples live in the browser, so this module must
 * stay out of the server-only dependency graph (no helpers.ts, no
 * openapi-sampler). Requests are assembled once by `buildRequest` in
 * `request.ts`; the builders here only render a finished `RequestSample` as
 * simple, copy-pasteable starter code — not an exhaustive SDK.
 */

export interface RequestSample {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON-stringified request body, when the operation takes one. */
  body?: string;
  bodyValue?: unknown;
}

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
