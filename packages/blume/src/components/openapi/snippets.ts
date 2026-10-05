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

const fetchCall = (sample: RequestSample, declaration: string): string => {
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
  return `${form}const ${declaration} = await fetch(${stringLiteral(sample.url)}, {\n${options.join(
    ",\n"
  )}\n});`;
};

const fetchSnippet = (sample: RequestSample): string =>
  fetchCall(sample, "response");

const typescriptSnippet = (sample: RequestSample): string =>
  fetchCall(sample, "response: Response");

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

// ---------------------------------------------------------------------------
// Shared helpers for the compiled and scripting languages below
// ---------------------------------------------------------------------------

const hex = (code: number, width: number): string =>
  code.toString(16).padStart(width, "0");

/**
 * A string literal for a language with C-style escapes: the delimiter and
 * `\` escaped, newline, carriage return, and tab by name, any other control
 * character through `control` (each language spells a code point
 * differently, and some reject JSON's `\uXXXX`), and each character in
 * `sigils` backslash-escaped so it can't start an interpolation (`$` in
 * Kotlin and Dart, `#` in Ruby).
 */
const quoted = (
  value: string,
  control: (code: number) => string,
  sigils = "",
  delimiter = '"'
): string => {
  let out = delimiter;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === delimiter || char === "\\" || sigils.includes(char)) {
      out += `\\${char}`;
    } else if (char === "\n") {
      out += String.raw`\n`;
    } else if (char === "\r") {
      out += String.raw`\r`;
    } else if (char === "\t") {
      out += String.raw`\t`;
    } else if (code < 0x20 || code === 0x7f) {
      out += control(code);
    } else {
      out += char;
    }
  }
  return `${out}${delimiter}`;
};

const goString = (value: string): string =>
  quoted(value, (code) => `\\x${hex(code, 2)}`);
// Java decodes `\uXXXX` before it tokenizes, which is safe for a control
// character inside a string literal (only a line break isn't, and those are
// spelled `\n` and `\r`).
const javaString = (value: string): string =>
  quoted(value, (code) => `\\u${hex(code, 4)}`);
const csharpString = javaString;
// C and C++ reject a `\u` escape below U+00A0; octal always works. A `?`
// before another is escaped too, so no `??=`-style trigraph can form (strict
// C modes still translate them).
const cString = (value: string): string =>
  quoted(value, (code) => `\\${code.toString(8).padStart(3, "0")}`).replaceAll(
    /\?(?=\?)/gu,
    "?\\"
  );
const braceString = (value: string): string =>
  quoted(value, (code) => `\\u{${hex(code, 1)}}`);
const kotlinString = (value: string): string =>
  quoted(value, (code) => `\\u${hex(code, 4)}`, "$");
const rubyString = (value: string): string =>
  quoted(value, (code) => `\\u${hex(code, 4)}`, "#");
const dartString = (value: string): string =>
  quoted(value, (code) => `\\x${hex(code, 2)}`, "$", "'");

/**
 * A single-quoted PHP string: nothing interpolates, and only `\` and `'`
 * need escaping.
 */
const phpString = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", String.raw`\'`)}'`;

/**
 * A single-quoted PowerShell string: nothing expands, and a quote is doubled.
 * PowerShell also closes a string on the typographic single quotes, so those
 * are doubled too.
 */
const powershellString = (value: string): string =>
  `'${value.replaceAll(/['‘’‚‛]/gu, (quote) => quote + quote)}'`;

/** A request's `Content-Type` apart from its other headers. */
interface ContentTypeSplit {
  contentType: string | undefined;
  rest: [string, string][];
}

/** The request's `Content-Type`, and its other headers without it. */
const splitContentType = (
  headers: Record<string, string>
): ContentTypeSplit => {
  const entries = Object.entries(headers);
  const match = entries.find(([key]) => key.toLowerCase() === "content-type");
  return {
    contentType: match?.[1],
    rest: entries.filter(([key]) => key.toLowerCase() !== "content-type"),
  };
};

/**
 * The boundary for a multipart body written out by hand, for clients with no
 * form builder of their own (Java's and Swift's).
 */
const MULTIPART_BOUNDARY = "BlumeFormBoundary7MA4YWxkTrZu0gW";

/** A `multipart/form-data` body for `parts`, as the bytes on the wire. */
const multipartBody = (parts: [string, string][]): string =>
  [
    ...parts.map(
      ([name, value]) =>
        `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name
          .replaceAll('"', "%22")
          .replaceAll("\r", "%0D")
          .replaceAll("\n", "%0A")}"\r\n\r\n${value}\r\n`
    ),
    `--${MULTIPART_BOUNDARY}--\r\n`,
  ].join("");

/** A note in place of a sample whose client can't send `method`. */
const unsupportedMethod = (
  comment: string,
  client: string,
  method: string
): string =>
  `${comment} ${client} has no ${method} method, so there's no sample for this\n${comment} operation here. Send it with curl or another HTTP client instead.`;

// ---------------------------------------------------------------------------
// Node.js (axios)
// ---------------------------------------------------------------------------

const nodeSnippet = (sample: RequestSample): string => {
  const config = [
    `  method: ${stringLiteral(sample.method)}`,
    `  url: ${stringLiteral(sample.url)}`,
  ];
  if (Object.keys(sample.headers).length > 0) {
    const headers = headerLines(
      sample.headers,
      (key, value) => `    ${stringLiteral(key)}: ${stringLiteral(value)}`
    ).join(",\n");
    config.push(`  headers: {\n${headers}\n  }`);
  }
  if (sample.body) {
    config.push(`  data: ${stringLiteral(sample.body)}`);
  }
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
    config.push("  data: form");
  }
  return `import axios from "axios";\n\n${form}const response = await axios.request({\n${config.join(",\n")}\n});`;
};

// ---------------------------------------------------------------------------
// PHP (the curl extension)
// ---------------------------------------------------------------------------

const phpSnippet = (sample: RequestSample): string => {
  const options = [
    `  CURLOPT_URL => ${phpString(sample.url)}`,
    "  CURLOPT_RETURNTRANSFER => true",
    // As with `curl --head`: a HEAD request expects no body.
    sample.method === "HEAD"
      ? "  CURLOPT_NOBODY => true"
      : `  CURLOPT_CUSTOMREQUEST => ${phpString(sample.method)}`,
  ];
  const headers = Object.entries(sample.headers);
  if (headers.length > 0) {
    const lines = headers.map(
      ([key, value]) => `    ${phpString(`${key}: ${value}`)},\n`
    );
    options.push(`  CURLOPT_HTTPHEADER => [\n${lines.join("")}  ]`);
  }
  if (sample.body) {
    options.push(`  CURLOPT_POSTFIELDS => ${phpString(sample.body)}`);
  }
  if (sample.formData) {
    // An array (rather than a string) makes curl send multipart/form-data.
    const fields = sample.formData.map(
      ([name, value]) => `    ${phpString(name)} => ${phpString(value)},\n`
    );
    options.push(`  CURLOPT_POSTFIELDS => [\n${fields.join("")}  ]`);
  }
  return `<?php\n\n$curl = curl_init();\n\ncurl_setopt_array($curl, [\n${options.join(",\n")},\n]);\n\n$response = curl_exec($curl);`;
};

// ---------------------------------------------------------------------------
// Go (net/http)
// ---------------------------------------------------------------------------

const goSnippet = (sample: RequestSample): string => {
  const imports = new Set(["fmt", "io", "net/http"]);
  const lines: string[] = [];
  let body = "nil";
  if (sample.formData) {
    imports.add("bytes");
    imports.add("mime/multipart");
    lines.push(
      "\tvar body bytes.Buffer",
      "\tform := multipart.NewWriter(&body)",
      ...sample.formData.map(
        ([name, value]) =>
          `\tform.WriteField(${goString(name)}, ${goString(value)})`
      ),
      "\tform.Close()",
      ""
    );
    body = "&body";
  } else if (sample.body) {
    imports.add("strings");
    lines.push(`\tbody := strings.NewReader(${goString(sample.body)})`);
    body = "body";
  }
  lines.push(
    `\treq, err := http.NewRequest(${goString(sample.method)}, ${goString(sample.url)}, ${body})`,
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}"
  );
  for (const [key, value] of Object.entries(sample.headers)) {
    lines.push(`\treq.Header.Set(${goString(key)}, ${goString(value)})`);
  }
  if (sample.formData) {
    lines.push('\treq.Header.Set("Content-Type", form.FormDataContentType())');
  }
  lines.push(
    "",
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "",
    "\tdata, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(string(data))"
  );
  const importBlock = [...imports]
    .toSorted()
    .map((path) => `\t"${path}"`)
    .join("\n");
  return `package main\n\nimport (\n${importBlock}\n)\n\nfunc main() {\n${lines.join("\n")}\n}`;
};

// ---------------------------------------------------------------------------
// Java (java.net.http)
// ---------------------------------------------------------------------------

const javaSnippet = (sample: RequestSample): string => {
  const builder = [`    .uri(URI.create(${javaString(sample.url)}))`];
  for (const [key, value] of Object.entries(sample.headers)) {
    builder.push(`    .header(${javaString(key)}, ${javaString(value)})`);
  }
  let body = "HttpRequest.BodyPublishers.noBody()";
  if (sample.formData) {
    builder.push(
      `    .header("Content-Type", ${javaString(`multipart/form-data; boundary=${MULTIPART_BOUNDARY}`)})`
    );
    body = `HttpRequest.BodyPublishers.ofString(${javaString(multipartBody(sample.formData))})`;
  } else if (sample.body) {
    body = `HttpRequest.BodyPublishers.ofString(${javaString(sample.body)})`;
  }
  builder.push(
    `    .method(${javaString(sample.method)}, ${body})`,
    "    .build();"
  );
  return [
    "import java.net.URI;",
    "import java.net.http.HttpClient;",
    "import java.net.http.HttpRequest;",
    "import java.net.http.HttpResponse;",
    "",
    "HttpRequest request = HttpRequest.newBuilder()",
    ...builder,
    "HttpResponse<String> response = HttpClient.newHttpClient()",
    "    .send(request, HttpResponse.BodyHandlers.ofString());",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Ruby (net/http)
// ---------------------------------------------------------------------------

/** The `Net::HTTP` request class for each method it names. */
const RUBY_METHODS = new Map([
  ["DELETE", "Delete"],
  ["GET", "Get"],
  ["HEAD", "Head"],
  ["OPTIONS", "Options"],
  ["PATCH", "Patch"],
  ["POST", "Post"],
  ["PUT", "Put"],
  ["TRACE", "Trace"],
]);

const rubySnippet = (sample: RequestSample): string => {
  const known = RUBY_METHODS.get(sample.method);
  const lines = [
    'require "net/http"',
    "",
    `uri = URI(${rubyString(sample.url)})`,
    known
      ? `request = Net::HTTP::${known}.new(uri)`
      : `request = Net::HTTPGenericRequest.new(${rubyString(sample.method)}, true, true, uri)`,
  ];
  for (const [key, value] of Object.entries(sample.headers)) {
    lines.push(`request[${rubyString(key)}] = ${rubyString(value)}`);
  }
  if (sample.body) {
    lines.push(`request.body = ${rubyString(sample.body)}`);
  }
  if (sample.formData) {
    const fields = sample.formData
      .map(([name, value]) => `[${rubyString(name)}, ${rubyString(value)}]`)
      .join(", ");
    lines.push(`request.set_form([${fields}], "multipart/form-data")`);
  }
  lines.push(
    "",
    'response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|',
    "  http.request(request)",
    "end"
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// PowerShell (Invoke-RestMethod)
// ---------------------------------------------------------------------------

/** The methods `Invoke-RestMethod -Method` names; others take `-CustomMethod`. */
const POWERSHELL_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

const powershellSnippet = (sample: RequestSample): string => {
  const { contentType, rest } = splitContentType(sample.headers);
  const lines: string[] = [];
  const args = [
    `-Uri ${powershellString(sample.url)}`,
    POWERSHELL_METHODS.has(sample.method)
      ? `-Method ${sample.method}`
      : `-CustomMethod ${powershellString(sample.method)}`,
  ];
  if (rest.length > 0) {
    lines.push(
      "$headers = @{",
      ...rest.map(
        ([key, value]) =>
          `  ${powershellString(key)} = ${powershellString(value)}`
      ),
      "}"
    );
    args.push("-Headers $headers");
  }
  // Invoke-RestMethod takes the body's type as a parameter, not a header.
  if (contentType) {
    args.push(`-ContentType ${powershellString(contentType)}`);
  }
  if (sample.body) {
    args.push(`-Body ${powershellString(sample.body)}`);
  }
  if (sample.formData) {
    lines.push(
      "$form = @{",
      ...sample.formData.map(
        ([name, value]) =>
          `  ${powershellString(name)} = ${powershellString(value)}`
      ),
      "}"
    );
    args.push("-Form $form");
  }
  lines.push(`$response = Invoke-RestMethod ${args.join(" ")}`);
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Swift (URLSession)
// ---------------------------------------------------------------------------

const swiftSnippet = (sample: RequestSample): string => {
  const lines = [
    "import Foundation",
    "",
    `var request = URLRequest(url: URL(string: ${braceString(sample.url)})!)`,
    `request.httpMethod = ${braceString(sample.method)}`,
  ];
  for (const [key, value] of Object.entries(sample.headers)) {
    lines.push(
      `request.setValue(${braceString(value)}, forHTTPHeaderField: ${braceString(key)})`
    );
  }
  if (sample.formData) {
    lines.push(
      `request.setValue(${braceString(`multipart/form-data; boundary=${MULTIPART_BOUNDARY}`)}, forHTTPHeaderField: "Content-Type")`,
      `request.httpBody = Data(${braceString(multipartBody(sample.formData))}.utf8)`
    );
  } else if (sample.body) {
    lines.push(`request.httpBody = Data(${braceString(sample.body)}.utf8)`);
  }
  lines.push(
    "",
    "let (data, response) = try await URLSession.shared.data(for: request)"
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// C# (HttpClient)
// ---------------------------------------------------------------------------

const csharpSnippet = (sample: RequestSample): string => {
  const { contentType, rest } = splitContentType(sample.headers);
  const lines = [
    "using System.Net.Http;",
    "using System.Net.Http.Headers;",
    "",
    "using var client = new HttpClient();",
    `var request = new HttpRequestMessage(new HttpMethod(${csharpString(sample.method)}), ${csharpString(sample.url)});`,
  ];
  // Without validation, so a header .NET would reformat is sent as written.
  for (const [key, value] of rest) {
    lines.push(
      `request.Headers.TryAddWithoutValidation(${csharpString(key)}, ${csharpString(value)});`
    );
  }
  if (sample.body) {
    lines.push(
      `request.Content = new StringContent(${csharpString(sample.body)});`
    );
    // The body's type is a content header in .NET, not a request header.
    if (contentType) {
      lines.push(
        `request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${csharpString(contentType)});`
      );
    }
  }
  if (sample.formData) {
    lines.push(
      "var form = new MultipartFormDataContent();",
      ...sample.formData.map(
        ([name, value]) =>
          `form.Add(new StringContent(${csharpString(value)}), ${csharpString(name)});`
      ),
      "request.Content = form;"
    );
  }
  lines.push(
    "",
    "var response = await client.SendAsync(request);",
    "var body = await response.Content.ReadAsStringAsync();"
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// .NET (RestSharp)
// ---------------------------------------------------------------------------

/** RestSharp's `Method` members, by HTTP method. */
const RESTSHARP_METHODS = new Map([
  ["DELETE", "Delete"],
  ["GET", "Get"],
  ["HEAD", "Head"],
  ["OPTIONS", "Options"],
  ["PATCH", "Patch"],
  ["POST", "Post"],
  ["PUT", "Put"],
]);

const dotnetSnippet = (sample: RequestSample): string => {
  const method = RESTSHARP_METHODS.get(sample.method);
  if (!method) {
    return unsupportedMethod("//", "RestSharp", sample.method);
  }
  const { contentType, rest } = splitContentType(sample.headers);
  const lines = [
    "using RestSharp;",
    "",
    "var client = new RestClient();",
    `var request = new RestRequest(${csharpString(sample.url)}, Method.${method});`,
  ];
  for (const [key, value] of rest) {
    lines.push(
      `request.AddHeader(${csharpString(key)}, ${csharpString(value)});`
    );
  }
  if (sample.body) {
    // The body carries its own type; a Content-Type header would be ignored.
    lines.push(
      `request.AddStringBody(${csharpString(sample.body)}, ${csharpString(contentType ?? "text/plain")});`
    );
  }
  if (sample.formData) {
    lines.push(
      "request.AlwaysMultipartFormData = true;",
      ...sample.formData.map(
        ([name, value]) =>
          `request.AddParameter(${csharpString(name)}, ${csharpString(value)});`
      )
    );
  }
  lines.push("", "var response = await client.ExecuteAsync(request);");
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// C (libcurl)
// ---------------------------------------------------------------------------

const cSnippet = (sample: RequestSample): string => {
  const lines = [
    "#include <curl/curl.h>",
    "",
    "int main(void) {",
    "  CURL *curl = curl_easy_init();",
  ];
  const headers = Object.entries(sample.headers);
  if (headers.length > 0) {
    lines.push("  struct curl_slist *headers = NULL;");
    for (const [key, value] of headers) {
      lines.push(
        `  headers = curl_slist_append(headers, ${cString(`${key}: ${value}`)});`
      );
    }
  }
  lines.push(
    "",
    `  curl_easy_setopt(curl, CURLOPT_URL, ${cString(sample.url)});`,
    // As with `curl --head`: a HEAD request expects no body.
    sample.method === "HEAD"
      ? "  curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);"
      : `  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, ${cString(sample.method)});`
  );
  if (headers.length > 0) {
    lines.push("  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);");
  }
  if (sample.body) {
    lines.push(
      `  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, ${cString(sample.body)});`
    );
  }
  if (sample.formData) {
    lines.push(
      "",
      "  curl_mime *form = curl_mime_init(curl);",
      "  curl_mimepart *part;"
    );
    for (const [name, value] of sample.formData) {
      lines.push(
        "  part = curl_mime_addpart(form);",
        `  curl_mime_name(part, ${cString(name)});`,
        `  curl_mime_data(part, ${cString(value)}, CURL_ZERO_TERMINATED);`
      );
    }
    lines.push("  curl_easy_setopt(curl, CURLOPT_MIMEPOST, form);");
  }
  lines.push("", "  CURLcode result = curl_easy_perform(curl);", "");
  if (sample.formData) {
    lines.push("  curl_mime_free(form);");
  }
  if (headers.length > 0) {
    lines.push("  curl_slist_free_all(headers);");
  }
  lines.push(
    "  curl_easy_cleanup(curl);",
    "  return result == CURLE_OK ? 0 : 1;",
    "}"
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// C++ (cpr)
// ---------------------------------------------------------------------------

/** cpr's request functions, by HTTP method. */
const CPR_METHODS = new Map([
  ["DELETE", "Delete"],
  ["GET", "Get"],
  ["HEAD", "Head"],
  ["OPTIONS", "Options"],
  ["PATCH", "Patch"],
  ["POST", "Post"],
  ["PUT", "Put"],
]);

const cppSnippet = (sample: RequestSample): string => {
  const method = CPR_METHODS.get(sample.method);
  if (!method) {
    return unsupportedMethod("//", "cpr", sample.method);
  }
  const args = [`      cpr::Url{${cString(sample.url)}}`];
  const headers = Object.entries(sample.headers);
  if (headers.length > 0) {
    const pairs = headers
      .map(([key, value]) => `{${cString(key)}, ${cString(value)}}`)
      .join(", ");
    args.push(`      cpr::Header{${pairs}}`);
  }
  if (sample.body) {
    args.push(`      cpr::Body{${cString(sample.body)}}`);
  }
  if (sample.formData) {
    const parts = sample.formData
      .map(([name, value]) => `{${cString(name)}, ${cString(value)}}`)
      .join(", ");
    args.push(`      cpr::Multipart{${parts}}`);
  }
  return [
    "#include <cpr/cpr.h>",
    "",
    "int main() {",
    `  cpr::Response response = cpr::${method}(`,
    `${args.join(",\n")});`,
    "}",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Kotlin (OkHttp)
// ---------------------------------------------------------------------------

/** Methods OkHttp refuses to send a body with, and ones it requires one for. */
const OKHTTP_NO_BODY = new Set(["GET", "HEAD"]);
const OKHTTP_NEEDS_BODY = new Set(["PATCH", "POST", "PUT"]);

const kotlinSnippet = (sample: RequestSample): string => {
  const { contentType, rest } = splitContentType(sample.headers);
  const imports = new Set(["okhttp3.OkHttpClient", "okhttp3.Request"]);
  let body = "null";
  if (sample.formData) {
    imports.add("okhttp3.MultipartBody");
    const parts = sample.formData
      .map(
        ([name, value]) =>
          `\n    .addFormDataPart(${kotlinString(name)}, ${kotlinString(value)})`
      )
      .join("");
    body = `MultipartBody.Builder()\n    .setType(MultipartBody.FORM)${parts}\n    .build()`;
  } else if (sample.body && !OKHTTP_NO_BODY.has(sample.method)) {
    imports.add("okhttp3.RequestBody.Companion.toRequestBody");
    // OkHttp takes the body's type from the body, not from a header.
    let mediaType = "";
    if (contentType) {
      imports.add("okhttp3.MediaType.Companion.toMediaType");
      mediaType = `${kotlinString(contentType)}.toMediaType()`;
    }
    body = `${kotlinString(sample.body)}.toRequestBody(${mediaType})`;
  } else if (OKHTTP_NEEDS_BODY.has(sample.method)) {
    imports.add("okhttp3.RequestBody.Companion.toRequestBody");
    body = '"".toRequestBody()';
  }
  const builder = [`  .url(${kotlinString(sample.url)})`];
  builder.push(
    `  .method(${kotlinString(sample.method)}, ${body.replaceAll("\n", "\n  ")})`
  );
  for (const [key, value] of rest) {
    builder.push(`  .addHeader(${kotlinString(key)}, ${kotlinString(value)})`);
  }
  builder.push("  .build()");
  const importLines = [...imports]
    .toSorted()
    .map((name) => `import ${name}`)
    .join("\n");
  return [
    importLines,
    "",
    "val client = OkHttpClient()",
    "",
    "val request = Request.Builder()",
    ...builder,
    "",
    "client.newCall(request).execute().use { response ->",
    "  println(response.body?.string())",
    "}",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Rust (reqwest)
// ---------------------------------------------------------------------------

/** The methods `reqwest::Method` has a constant for. */
const RUST_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

const rustSnippet = (sample: RequestSample): string => {
  const method = RUST_METHODS.has(sample.method)
    ? `reqwest::Method::${sample.method}`
    : `reqwest::Method::from_bytes(${braceString(sample.method)}.as_bytes()).unwrap()`;
  const chain = [`        .request(${method}, ${braceString(sample.url)})`];
  for (const [key, value] of Object.entries(sample.headers)) {
    chain.push(`        .header(${braceString(key)}, ${braceString(value)})`);
  }
  if (sample.body) {
    chain.push(`        .body(${braceString(sample.body)})`);
  }
  const lines = [
    "#[tokio::main]",
    "async fn main() -> Result<(), reqwest::Error> {",
  ];
  if (sample.formData) {
    // Needs reqwest's `multipart` feature.
    const parts = sample.formData
      .map(
        ([name, value]) =>
          `\n        .text(${braceString(name)}, ${braceString(value)})`
      )
      .join("");
    lines.push(`    let form = reqwest::multipart::Form::new()${parts};`, "");
    chain.push("        .multipart(form)");
  }
  lines.push(
    "    let response = reqwest::Client::new()",
    ...chain,
    "        .send()",
    "        .await?;",
    "",
    '    println!("{}", response.text().await?);',
    "    Ok(())",
    "}"
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Dart (package:http)
// ---------------------------------------------------------------------------

const dartSnippet = (sample: RequestSample): string => {
  const lines = ["import 'package:http/http.dart' as http;", ""];
  const target = `${dartString(sample.method)}, Uri.parse(${dartString(sample.url)})`;
  if (sample.formData) {
    lines.push(`final request = http.MultipartRequest(${target});`);
    for (const [name, value] of sample.formData) {
      lines.push(`request.fields[${dartString(name)}] = ${dartString(value)};`);
    }
  } else {
    lines.push(`final request = http.Request(${target});`);
  }
  const headers = Object.entries(sample.headers);
  if (headers.length > 0) {
    lines.push(
      "request.headers.addAll({",
      ...headers.map(
        ([key, value]) => `  ${dartString(key)}: ${dartString(value)},`
      ),
      "});"
    );
  }
  if (sample.body) {
    lines.push(`request.body = ${dartString(sample.body)};`);
  }
  lines.push(
    "",
    "final response = await request.send();",
    "print(await response.stream.bytesToString());"
  );
  return lines.join("\n");
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
  { build: pythonSnippet, id: "python", label: "Python", lang: "python" },
  { build: fetchSnippet, id: "js", label: "JavaScript", lang: "js" },
  { build: nodeSnippet, id: "node", label: "Node.js", lang: "js" },
  {
    build: typescriptSnippet,
    id: "typescript",
    label: "TypeScript",
    lang: "ts",
  },
  { build: phpSnippet, id: "php", label: "PHP", lang: "php" },
  { build: goSnippet, id: "go", label: "Go", lang: "go" },
  { build: javaSnippet, id: "java", label: "Java", lang: "java" },
  { build: rubySnippet, id: "ruby", label: "Ruby", lang: "ruby" },
  {
    build: powershellSnippet,
    id: "powershell",
    label: "PowerShell",
    lang: "powershell",
  },
  { build: swiftSnippet, id: "swift", label: "Swift", lang: "swift" },
  { build: csharpSnippet, id: "csharp", label: "C#", lang: "csharp" },
  { build: dotnetSnippet, id: "dotnet", label: ".NET", lang: "csharp" },
  { build: cSnippet, id: "c", label: "C", lang: "c" },
  { build: cppSnippet, id: "cpp", label: "C++", lang: "cpp" },
  { build: kotlinSnippet, id: "kotlin", label: "Kotlin", lang: "kotlin" },
  { build: rustSnippet, id: "rust", label: "Rust", lang: "rust" },
  { build: dartSnippet, id: "dart", label: "Dart", lang: "dart" },
];

/** Every id `codeSamples` accepts for a generated sample. */
export const SAMPLE_LANGUAGE_IDS = LANGUAGES.map((language) => language.id);

/** Other spellings of the ids, including every alias Mintlify accepts. */
const ALIASES = new Map([
  [".net", "dotnet"],
  ["bash", "curl"],
  ["c#", "csharp"],
  ["c++", "cpp"],
  ["cs", "csharp"],
  ["dot-net", "dotnet"],
  ["flutter", "dart"],
  ["golang", "go"],
  ["javascript", "js"],
  ["kt", "kotlin"],
  ["node.js", "node"],
  ["nodejs", "node"],
  ["ps1", "powershell"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sh", "curl"],
  ["shell", "curl"],
  ["ts", "typescript"],
]);

/** A configured id or alias, as the id it names (lowercased). */
export const sampleLanguageId = (raw: string): string => {
  const lower = raw.toLowerCase();
  return ALIASES.get(lower) ?? lower;
};

/** A language's display name and the Shiki language that highlights it. */
export interface SampleLanguageInfo {
  label: string;
  lang: string;
}

/**
 * The display name and Shiki language of a language id or alias, or `null`
 * when Blume doesn't generate that language.
 */
export const sampleLanguageInfo = (raw: string): SampleLanguageInfo | null => {
  const id = sampleLanguageId(raw);
  const language = LANGUAGES.find((entry) => entry.id === id);
  return language ? { label: language.label, lang: language.lang } : null;
};

/** `openapi()`'s default `codeSamples`, which hand-written endpoint pages always use. */
export const DEFAULT_SAMPLE_LANGUAGES = ["curl", "js", "python"];

/**
 * The sample languages to render, resolved from config ids (unknown ids
 * dropped), in order. `false` and an empty list both render none.
 */
export const sampleLanguages = (ids: string[] | false): SampleLanguage[] => {
  if (ids === false) {
    return [];
  }
  const byId = new Map(LANGUAGES.map((entry) => [entry.id, entry]));
  const out: SampleLanguage[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = sampleLanguageId(raw);
    const language = byId.get(id);
    if (language && !seen.has(id)) {
      seen.add(id);
      out.push(language);
    }
  }
  return out;
};
