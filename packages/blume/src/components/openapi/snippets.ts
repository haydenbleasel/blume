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
  /**
   * The request body as sent, when the operation takes one: JSON text,
   * form-urlencoded pairs, or a raw media type's text.
   */
  body?: string;
  bodyValue?: unknown;
  /**
   * A `multipart/form-data` body's parts as `[name, value]` pairs, set
   * instead of `body`. The request carries no Content-Type of its own for
   * them: the client writes one with the parts' boundary.
   */
  formData?: [string, string][];
}

const headerLines = (
  headers: Record<string, string>,
  format: (key: string, value: string) => string
): string[] =>
  Object.entries(headers).map(([key, value]) => format(key, value));

/**
 * A single-quoted POSIX shell word. Nothing expands inside single quotes — no
 * `$`, backtick, `!`, or `\` — so a value reaches curl byte for byte; a
 * literal `'` closes the quote, adds an escaped one, and reopens it.
 */
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * A double-quoted string literal for the JavaScript and Python samples. JSON's
 * string escapes are a subset of both languages' — a quote in a header value
 * (`If-Match: "33a64df5"`) or a backslash becomes an escape rather than
 * ending the literal early.
 */
const stringLiteral = (value: string): string => JSON.stringify(value);

const curlSnippet = (sample: RequestSample): string => {
  const lines = [
    // `-X HEAD` sends a HEAD but still waits for the body the response
    // announces, so the command hangs; `--head` knows there is none.
    sample.method === "HEAD"
      ? `curl --head ${shellQuote(sample.url)}`
      : `curl -X ${sample.method} ${shellQuote(sample.url)}`,
    ...headerLines(
      sample.headers,
      (key, value) => `  -H ${shellQuote(`${key}: ${value}`)}`
    ),
  ];
  if (sample.body) {
    lines.push(`  -d ${shellQuote(sample.body)}`);
  }
  // `--form-string`, not `-F`: `-F` reads a value starting with `@` or `<` as
  // a file to upload.
  for (const [name, value] of sample.formData ?? []) {
    lines.push(`  --form-string ${shellQuote(`${name}=${value}`)}`);
  }
  return lines.join(" \\\n");
};

/**
 * Whether fetch refuses to send `method` (an upper-case HTTP method). TRACE is
 * one of the Fetch standard's forbidden methods, and the only one an OpenAPI
 * spec can declare: browsers and Node's fetch alike throw a TypeError before
 * any request goes out.
 */
export const fetchRefusesMethod = (method: string): boolean =>
  method === "TRACE";

/**
 * The JavaScript sample for a method fetch refuses: a note in place of a call
 * that could only throw.
 */
const FETCH_REFUSED_NOTE = [
  "// fetch() refuses the TRACE method: browsers and Node both throw before",
  "// sending, so there's no fetch sample for this operation. Send it with",
  "// curl or another HTTP client instead.",
].join("\n");

const fetchSnippet = (sample: RequestSample): string => {
  if (fetchRefusesMethod(sample.method)) {
    return FETCH_REFUSED_NOTE;
  }
  const options = [`  method: ${stringLiteral(sample.method)}`];
  if (Object.keys(sample.headers).length > 0) {
    const headers = headerLines(
      sample.headers,
      (key, value) => `    ${stringLiteral(key)}: ${stringLiteral(value)}`
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
    options.push(`  body: ${stringLiteral(sample.body)}`);
  }
  // A FormData body: fetch writes the multipart Content-Type and boundary.
  let form = "";
  if (sample.formData) {
    form = [
      "const form = new FormData();\n",
      ...sample.formData.map(
        ([name, value]) =>
          `form.append(${stringLiteral(name)}, ${stringLiteral(value)});\n`
      ),
      "\n",
    ].join("");
    options.push("  body: form");
  }
  return `${form}const response = await fetch(${stringLiteral(sample.url)}, {\n${options.join(
    ",\n"
  )}\n});`;
};

/** The methods `requests` has a module-level helper for. */
const PYTHON_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

const pythonSnippet = (sample: RequestSample): string => {
  const args = [`    ${stringLiteral(sample.url)}`];
  if (Object.keys(sample.headers).length > 0) {
    const headers = headerLines(
      sample.headers,
      (key, value) => `        ${stringLiteral(key)}: ${stringLiteral(value)}`
    ).join(",\n");
    args.push(`    headers={\n${headers}\n    }`);
  }
  if (sample.body) {
    // Same rule as the fetch snippet: the raw text travels as a string via
    // `data=` rather than a `json=` dict — a Python literal re-serializes
    // `1e400` as `Infinity` and would otherwise diverge from the live send.
    args.push(`    data=${stringLiteral(sample.body)}`);
  }
  if (sample.formData) {
    // `files=` is what makes requests encode multipart; a `(None, value)`
    // tuple is a plain field rather than an upload.
    const parts = sample.formData.map(
      ([name, value]) =>
        `        (${stringLiteral(name)}, (None, ${stringLiteral(value)})),\n`
    );
    args.push(`    files=[\n${parts.join("")}    ]`);
  }
  // requests has a helper per common method; anything else (TRACE) goes
  // through `requests.request` with the method named.
  const method = sample.method.toLowerCase();
  let call = `requests.${method}`;
  if (!PYTHON_METHODS.has(method)) {
    call = "requests.request";
    args.unshift(`    ${stringLiteral(sample.method)}`);
  }
  return `import requests\n\nresponse = ${call}(\n${args.join(",\n")},\n)`;
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
