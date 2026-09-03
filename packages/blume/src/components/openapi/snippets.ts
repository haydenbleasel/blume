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
    // Always the raw editor text as a string literal, never re-read as a JS
    // expression: the sample must send byte-for-byte what the live request
    // sends, and an object literal doesn't round-trip every valid JSON
    // document — `{"__proto__":{"x":1}}` sets a prototype instead of a key,
    // and an id past 2^53 loses digits through a JS number. The string
    // literal also stays syntactically valid while the editor holds mid-edit
    // text that isn't JSON yet.
    options.push(`  body: ${JSON.stringify(sample.body)}`);
  }
  return `const response = await fetch("${sample.url}", {\n${options.join(
    ",\n"
  )}\n});`;
};

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
    // Same rule as the fetch snippet: the raw text travels as a string via
    // `data=` (JSON string escapes are a subset of Python's, so the literal is
    // valid) rather than a `json=` dict — a Python literal re-serializes
    // `1e400` as `Infinity` and would otherwise diverge from the live send.
    args.push(`    data=${JSON.stringify(sample.body)}`);
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

const ALIASES = new Map([
  ["bash", "curl"],
  ["javascript", "js"],
  ["node", "js"],
  ["py", "python"],
  ["shell", "curl"],
  ["typescript", "js"],
]);

/** The sample languages to render, resolved from config ids (unknown ids dropped). */
export const sampleLanguages = (ids: string[]): SampleLanguage[] => {
  const wanted = ids.length > 0 ? ids : ["curl", "js", "python"];
  const byId = new Map(LANGUAGES.map((entry) => [entry.id, entry]));
  const out: SampleLanguage[] = [];
  const seen = new Set<string>();
  for (const raw of wanted) {
    const id = ALIASES.get(raw.toLowerCase()) ?? raw.toLowerCase();
    const language = byId.get(id);
    if (language && !seen.has(id)) {
      seen.add(id);
      out.push(language);
    }
  }
  return out;
};
