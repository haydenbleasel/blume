import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { initPlayground } from "../src/components/openapi/playground-client.ts";
import type { PlaygroundModel } from "../src/components/openapi/request.ts";
import {
  asElement,
  el,
  fire,
  installFakeDom,
  must,
  storage,
} from "./fake-dom.ts";
import type { FakeEl } from "./fake-dom.ts";

/**
 * Tests for the lazily loaded "Try it" client
 * (`src/components/openapi/playground-client.ts`), driven against the minimal
 * fake DOM in `./fake-dom.ts`: a FakeEl tree implementing just enough
 * querySelector/attribute/event surface for the module, plus fake
 * document/localStorage/fetch globals restored after the suite. The module's
 * collaborators (request.ts, validate-json.ts, snippets.ts) are real — these
 * tests exercise the integrated pipeline the browser runs.
 */

// --- fake globals -----------------------------------------------------------

let fetchCalls: { init: RequestInit; url: string }[] = [];
let fetchImpl: () => Promise<Response> = () =>
  Promise.resolve(new Response("{}"));
const fakeFetch = (url: string, init: RequestInit): Promise<Response> => {
  fetchCalls.push({ init, url });
  return fetchImpl();
};

/** Set by `beforeAll`; reverts the globals the fake DOM swapped in. */
let restoreDom: () => void;

beforeAll(() => {
  restoreDom = installFakeDom({ fetch: fakeFetch });
});

afterAll(() => {
  restoreDom();
});

afterEach(() => {
  storage.clear();
  fetchCalls = [];
  fetchImpl = () => Promise.resolve(new Response("{}"));
});

// --- fixtures ----------------------------------------------------------------

const STORAGE_KEY = "blume-playground:petstore:getPet";

const bearerModel = (): PlaygroundModel => ({
  auth: [
    {
      carrier: { in: "header", name: "Authorization" },
      id: "bearerAuth",
      kind: "bearer",
      label: "Bearer token",
      placeholder: "YOUR_TOKEN",
      prefix: "Bearer ",
    },
  ],
  authOptional: false,
  method: "get",
  params: [
    { in: "path", name: "id", required: true, type: "string", value: "42" },
    { in: "query", name: "sort", required: false, type: "string", value: "" },
    {
      in: "header",
      name: "X-Trace",
      required: false,
      type: "string",
      value: "",
    },
  ],
  path: "/pets/{id}",
  servers: ["https://api.example.com"],
});

const flatModel = (): PlaygroundModel => ({
  auth: [],
  authOptional: true,
  body: {
    contentType: "application/json",
    example: '{\n  "name": "Rex"\n}',
    fields: [
      { name: "name", required: true, type: "string", value: "Rex" },
      { name: "age", required: false, type: "integer", value: "" },
      { name: "good", required: false, type: "boolean", value: "" },
      { name: "note", required: false, type: "string", value: "" },
    ],
  },
  method: "post",
  params: [],
  path: "/pets",
  servers: ["https://api.example.com"],
});

const deepModel = (): PlaygroundModel => ({
  auth: [],
  authOptional: true,
  body: {
    contentType: "application/json",
    example: '{\n  "name": "Rex"\n}',
    schema: {
      properties: { name: { type: "string" } },
      required: ["name"],
      type: "object",
    },
  },
  method: "post",
  params: [],
  path: "/pets",
  servers: ["https://api.example.com"],
});

const basicModel = (): PlaygroundModel => ({
  auth: [
    {
      carrier: { in: "header", name: "Authorization" },
      id: "basicAuth",
      kind: "basic",
      label: "Basic auth",
      placeholder: "YOUR_CREDENTIALS",
      prefix: "Basic ",
    },
    {
      carrier: { in: "query", name: "api_key" },
      id: "keyAuth",
      kind: "apiKey",
      label: "API key",
      placeholder: "YOUR_API_KEY",
      prefix: "",
    },
  ],
  authOptional: false,
  method: "get",
  params: [],
  path: "/pets",
  servers: ["https://api.example.com"],
});

const cookieModel = (): PlaygroundModel => ({
  auth: [
    {
      carrier: { in: "cookie", name: "session" },
      id: "cookieAuth",
      kind: "apiKey",
      label: "Session cookie",
      placeholder: "YOUR_SESSION",
      prefix: "",
    },
  ],
  authOptional: false,
  method: "get",
  params: [],
  path: "/pets",
  servers: ["https://api.example.com"],
});

interface Fixture {
  auth: Record<string, FakeEl>;
  bodyArea?: FakeEl;
  bodyErrors?: FakeEl;
  curlCode: FakeEl;
  custom: FakeEl;
  fields: Record<string, FakeEl>;
  js: FakeEl;
  params: Record<string, FakeEl>;
  remember: FakeEl;
  response: FakeEl;
  root: FakeEl;
  samplesAuthBox: FakeEl;
  sendButton: FakeEl;
  server: FakeEl;
  weird: FakeEl;
}

/** Build the server-rendered DOM Playground.astro + RequestPanel.astro emit. */
const createFixture = (model: PlaygroundModel, proxy?: string): Fixture => {
  const panel = el("div", { "data-operation-panel": "" });
  const curl = el("div", { "data-panel": "curl", "data-sample-lang": "curl" });
  const curlCode = el("code");
  curl.append(curlCode);
  // No <code> child: exercises the pane-itself fallback target.
  const js = el("div", { "data-panel": "js", "data-sample-lang": "js" });
  // Unknown language id: the client must skip it.
  const weird = el("div", { "data-sample-lang": "weird" });

  const root = el(
    "blume-playground",
    proxy
      ? { "data-proxy": proxy, "data-storage-key": STORAGE_KEY }
      : { "data-storage-key": STORAGE_KEY }
  );
  root.append(
    el(
      "script",
      { "data-playground-model": "", type: "application/json" },
      JSON.stringify(model)
    )
  );
  const server = el("select", { "data-server": "" });
  server.value = model.servers[0] ?? "";
  const custom = el("input", { "data-server-custom": "" });
  root.append(server, custom);

  const params: Record<string, FakeEl> = {};
  for (const param of model.params) {
    const input = el("input", { "data-param": `${param.in}:${param.name}` });
    input.value = param.value;
    params[param.name] = input;
    root.append(input);
  }

  const auth: Record<string, FakeEl> = {};
  for (const input of model.auth) {
    if (input.kind === "basic") {
      const username = el("input", { "data-auth-username": input.id });
      const password = el("input", { "data-auth-password": input.id });
      auth[`${input.id}:username`] = username;
      auth[`${input.id}:password`] = password;
      root.append(username, password);
    } else {
      const value = el("input", { "data-auth-value": input.id });
      auth[input.id] = value;
      root.append(value);
    }
  }
  const remember = el("input", { "data-auth-remember": "", type: "checkbox" });
  const samplesAuthBox = el("input", {
    "data-samples-auth": "",
    type: "checkbox",
  });
  root.append(remember, samplesAuthBox);

  const fields: Record<string, FakeEl> = {};
  let bodyArea: FakeEl | undefined;
  let bodyErrors: FakeEl | undefined;
  if (model.body?.fields) {
    for (const field of model.body.fields) {
      const input = el("input", { "data-body-field": field.name });
      input.value = field.value;
      fields[field.name] = input;
      root.append(input);
    }
  } else if (model.body) {
    bodyArea = el("textarea", { "data-body": "" });
    bodyArea.value = model.body.example;
    bodyErrors = el("div", { "data-body-errors": "" });
    root.append(bodyArea, bodyErrors);
  }

  const sendButton = el("button", { "data-send": "" });
  const response = el("div", { "data-response": "" });
  root.append(sendButton, response);
  panel.append(curl, js, weird, root);
  return {
    auth,
    bodyArea,
    bodyErrors,
    curlCode,
    custom,
    fields,
    js,
    params,
    remember,
    response,
    root,
    samplesAuthBox,
    sendButton,
    server,
    weird,
  };
};

const init = (fixture: Fixture): void =>
  initPlayground(asElement(fixture.root));

/** Dispatch the delegated edit event the client listens for on the root. */
const edit = (fixture: Fixture, target: FakeEl, type = "input"): void => {
  fire(fixture.root, type, target);
};

const clickSend = async (fixture: Fixture): Promise<void> => {
  await Promise.all(fire(fixture.sendButton, "click", fixture.sendButton));
};

// --- tests --------------------------------------------------------------------

describe("sample sync", () => {
  it("re-renders every known pane from the live form, redacted by default", () => {
    const fixture = createFixture(bearerModel());
    init(fixture);

    edit(fixture, must(fixture.params.id));
    expect(fixture.curlCode.textContent).toContain(
      'curl -X GET "https://api.example.com/pets/42"'
    );
    expect(fixture.curlCode.textContent).toContain(
      '-H "Authorization: Bearer YOUR_TOKEN"'
    );
    // The js pane has no <code> child — the pane itself is the target.
    expect(fixture.js.textContent).toContain("fetch(");
    // Unknown language panes stay untouched.
    expect(fixture.weird.textContent).toBe("");

    // Edits to path/query/header params and the custom server flow through.
    must(fixture.params.id).value = "7";
    must(fixture.params.sort).value = "asc";
    must(fixture.params["X-Trace"]).value = "trace-1";
    fixture.custom.value = "https://alt.example.com/";
    edit(fixture, must(fixture.params.sort));
    expect(fixture.curlCode.textContent).toContain(
      'curl -X GET "https://alt.example.com/pets/7?sort=asc"'
    );
    expect(fixture.curlCode.textContent).toContain('-H "X-Trace: trace-1"');
  });

  it("includes real credentials in samples only after opt-in", () => {
    const fixture = createFixture(bearerModel());
    init(fixture);

    must(fixture.auth.bearerAuth).value = "sekret";
    edit(fixture, must(fixture.auth.bearerAuth));
    expect(fixture.curlCode.textContent).toContain("Bearer YOUR_TOKEN");
    expect(fixture.curlCode.textContent).not.toContain("sekret");

    fixture.samplesAuthBox.checked = true;
    edit(fixture, fixture.samplesAuthBox, "change");
    expect(fixture.curlCode.textContent).toContain("Bearer sekret");

    fixture.samplesAuthBox.checked = false;
    edit(fixture, fixture.samplesAuthBox, "change");
    expect(fixture.curlCode.textContent).toContain("Bearer YOUR_TOKEN");
  });
});

describe("flat body assembly", () => {
  it("coerces typed fields and omits empty optionals", async () => {
    const fixture = createFixture(flatModel());
    init(fixture);
    must(fixture.fields.age).value = "3";
    must(fixture.fields.good).value = "true";
    edit(fixture, must(fixture.fields.age));

    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(1);
    expect(must(fetchCalls[0]).url).toBe("https://api.example.com/pets");
    expect(must(fetchCalls[0]).init.method).toBe("POST");
    expect(
      // SAFETY: the client assembles `init.headers` as a plain string-keyed
      // object literal, never a `Headers` instance or entry array.
      (must(fetchCalls[0]).init.headers as Record<string, string>)[
        "Content-Type"
      ]
    ).toBe("application/json");
    // SAFETY: a flat-fields body is always JSON.stringify output — a string.
    expect(JSON.parse(must(fetchCalls[0]).init.body as string)).toEqual({
      age: 3,
      good: true,
      name: "Rex",
    });
  });

  it("keeps unparseable typed input verbatim and empty required fields", async () => {
    const fixture = createFixture(flatModel());
    init(fixture);
    must(fixture.fields.name).value = "";
    must(fixture.fields.age).value = "many";
    must(fixture.fields.good).value = "maybe";
    await clickSend(fixture);
    // SAFETY: a flat-fields body is always JSON.stringify output — a string.
    expect(JSON.parse(must(fetchCalls[0]).init.body as string)).toEqual({
      age: "many",
      good: "maybe",
      name: "",
    });
  });

  it("leaves a blank required numeric or boolean field blank on the wire", async () => {
    // `Number("")` is 0 and would invent a value the reader never typed, hiding
    // the miss the API is supposed to report.
    const model = flatModel();
    for (const field of must(must(model.body).fields)) {
      field.required = true;
      field.value = "";
    }
    const fixture = createFixture(model);
    init(fixture);
    await clickSend(fixture);
    // SAFETY: a flat-fields body is always JSON.stringify output — a string.
    expect(JSON.parse(must(fetchCalls[0]).init.body as string)).toEqual({
      age: "",
      good: "",
      name: "",
      note: "",
    });
  });

  it("collects a field whose name needs selector escaping", async () => {
    // An unescaped `"` in a spec-derived name would make `querySelector`
    // throw a SyntaxError and take down every sync and send.
    const model = flatModel();
    must(must(model.body).fields).push({
      name: 'size"large',
      required: false,
      type: "string",
      value: "",
    });
    const fixture = createFixture(model);
    init(fixture);
    must(fixture.fields['size"large']).value = "XL";
    edit(fixture, must(fixture.fields['size"large']));
    await clickSend(fixture);
    // SAFETY: a flat-fields body is always JSON.stringify output — a string.
    expect(JSON.parse(must(fetchCalls[0]).init.body as string)).toEqual({
      name: "Rex",
      'size"large': "XL",
    });
  });

  it("sends no body when every field is empty and optional", async () => {
    const model = flatModel();
    for (const field of must(must(model.body).fields)) {
      field.required = false;
      field.value = "";
    }
    const fixture = createFixture(model);
    init(fixture);
    await clickSend(fixture);
    expect(must(fetchCalls[0]).init.body).toBeUndefined();
  });
});

describe("deep body validation", () => {
  it("lists errors for invalid JSON and blocks the send", async () => {
    const fixture = createFixture(deepModel());
    init(fixture);

    must(fixture.bodyArea).value = "{ nope";
    edit(fixture, must(fixture.bodyArea));
    expect(must(fixture.bodyErrors).children.length).toBeGreaterThan(0);

    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(0);

    must(fixture.bodyArea).value = '{ "name": "Rex" }';
    edit(fixture, must(fixture.bodyArea));
    expect(must(fixture.bodyErrors).children).toHaveLength(0);
    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(1);
    expect(must(fetchCalls[0]).init.body).toBe('{ "name": "Rex" }');
  });

  it("treats a cleared editor as no body and sends it", async () => {
    const fixture = createFixture(deepModel());
    init(fixture);
    must(fixture.bodyArea).value = "  \n";
    edit(fixture, must(fixture.bodyArea));
    // An empty editor means "no body" (`bodyFor`), so there is nothing to
    // report and nothing to block.
    expect(must(fixture.bodyErrors).children).toHaveLength(0);
    must(fixture.bodyArea).value = "";
    edit(fixture, must(fixture.bodyArea));
    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(1);
    expect(must(fetchCalls[0]).init.body).toBeUndefined();
    expect(must(fetchCalls[0]).init.headers).not.toHaveProperty("Content-Type");
  });
});

describe("send + response rendering", () => {
  it("renders status, timing, headers, and pretty JSON", async () => {
    const fixture = createFixture(deepModel());
    init(fixture);
    fetchImpl = () =>
      Promise.resolve(
        new Response('{"ok":true,"n":1}', {
          headers: {
            "content-type": "application/json",
            "x-request-id": "abc",
          },
          status: 201,
          statusText: "Created",
        })
      );

    await clickSend(fixture);
    const [status, table, pre] = fixture.response.children;
    expect(must(status).textContent).toMatch(/^201 Created · \d+ ms$/u);
    expect(must(table).textContent).toContain("x-request-id");
    expect(must(table).textContent).toContain("abc");
    expect(must(pre).textContent).toBe('{\n  "ok": true,\n  "n": 1\n}');
  });

  it("scrolls an overflowing panel, never the document, to reveal the response", async () => {
    const fixture = createFixture(deepModel());
    init(fixture);
    const scrolls: ScrollToOptions[] = [];
    // At xl the panel is a viewport-capped scroller; the response region sits
    // partly below its fold.
    const panel = must(fixture.response.closest("[data-operation-panel]"));
    Object.assign(panel, {
      clientHeight: 400,
      getBoundingClientRect: () => ({ bottom: 400, top: 0 }),
      scrollBy: (options: ScrollToOptions) => scrolls.push(options),
      scrollHeight: 900,
    });
    Object.assign(fixture.response, {
      getBoundingClientRect: () => ({ bottom: 650, top: 500 }),
    });
    await clickSend(fixture);
    // "nearest": the smaller of the two moves that bring the region inside.
    expect(scrolls).toEqual([{ top: 250 }]);

    // Already in view: nothing moves.
    Object.assign(fixture.response, {
      getBoundingClientRect: () => ({ bottom: 300, top: 100 }),
    });
    await clickSend(fixture);
    expect(scrolls).toHaveLength(1);
  });

  it("renders non-JSON bodies verbatim, HTTP errors like any response", async () => {
    const fixture = createFixture(bearerModel());
    init(fixture);
    fetchImpl = () =>
      Promise.resolve(
        new Response("service on fire", { status: 500, statusText: "Nope" })
      );
    await clickSend(fixture);
    expect(must(fixture.response.children[0]).textContent).toMatch(
      /^500 Nope/u
    );
    expect(must(fixture.response.children[2]).textContent).toBe(
      "service on fire"
    );
  });

  it("routes through the proxy when configured", async () => {
    const fixture = createFixture(bearerModel(), "/_api-proxy");
    init(fixture);
    await clickSend(fixture);
    expect(must(fetchCalls[0]).url).toBe(
      `/_api-proxy?url=${encodeURIComponent("https://api.example.com/pets/42")}`
    );
  });

  it("joins with & when the proxy URL already carries a query string", async () => {
    // A hardcoded `?url=` would bury the target inside the existing parameter
    // and the proxy would never see a `url` at all.
    const fixture = createFixture(
      bearerModel(),
      "https://cors.example.com/fetch?key=abc"
    );
    init(fixture);
    await clickSend(fixture);
    const url = new URL(must(fetchCalls[0]).url);
    expect(url.searchParams.get("key")).toBe("abc");
    expect(url.searchParams.get("url")).toBe("https://api.example.com/pets/42");
  });

  it("omits an untouched auth input from the live send", async () => {
    // Samples show `Bearer YOUR_TOKEN`, but transmitting the placeholder as a
    // real credential would turn an anonymous-capable request into a 401.
    const fixture = createFixture(bearerModel());
    init(fixture);
    edit(fixture, must(fixture.params.id));
    await clickSend(fixture);
    expect(must(fetchCalls[0]).init.headers).not.toHaveProperty(
      "Authorization"
    );
    expect(fixture.curlCode.textContent).toContain("Bearer YOUR_TOKEN");

    must(fixture.auth.bearerAuth).value = "sekret";
    edit(fixture, must(fixture.auth.bearerAuth));
    await clickSend(fixture);
    expect(
      // SAFETY: the client assembles `init.headers` as a plain string-keyed
      // object literal, never a `Headers` instance or entry array.
      (must(fetchCalls[1]).init.headers as Record<string, string>).Authorization
    ).toBe("Bearer sekret");
  });

  it("omits untouched basic and api-key auth, sending only what was typed", async () => {
    const fixture = createFixture(basicModel());
    init(fixture);
    must(fixture.auth["basicAuth:username"]).value = "us";
    await clickSend(fixture);
    expect(
      // SAFETY: the client assembles `init.headers` as a plain string-keyed
      // object literal, never a `Headers` instance or entry array.
      (must(fetchCalls[0]).init.headers as Record<string, string>).Authorization
    ).toBe(`Basic ${btoa("us:")}`);
    // The untouched query api key contributes nothing to the wire.
    expect(must(fetchCalls[0]).url).toBe("https://api.example.com/pets");
  });

  it("reports an invalid custom URL instead of blaming CORS", async () => {
    // fetch would throw the same pre-network TypeError a CORS rejection
    // produces; the panel must show the real error, not the proxy advice.
    const fixture = createFixture(bearerModel());
    init(fixture);
    fixture.custom.value = "https://bad host";
    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(0);
    expect(fixture.response.textContent).toStartWith("Request failed:");
    expect(fixture.response.textContent).not.toContain("cross-origin");

    // Same for a header value fetch would reject (an interior newline).
    const again = createFixture(bearerModel());
    init(again);
    must(again.params["X-Trace"]).value = "a\nb";
    await clickSend(again);
    expect(fetchCalls).toHaveLength(0);
    expect(again.response.textContent).toStartWith("Request failed:");
  });

  it("explains the CORS wall on a rejected fetch, naming the proxy option", async () => {
    const fixture = createFixture(bearerModel());
    init(fixture);
    fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
    await clickSend(fixture);
    expect(fixture.response.textContent).toContain("cross-origin");
    expect(fixture.response.textContent).toContain(
      "`openapi.playground.proxy`"
    );

    fetchImpl = () => Promise.reject(new Error("boom"));
    await clickSend(fixture);
    expect(fixture.response.textContent).toBe("Request failed: Error: boom");
  });

  it("refuses to send a cookie credential the browser would drop", async () => {
    const fixture = createFixture(cookieModel());
    init(fixture);
    // Nothing typed: the placeholder cookie is meaningless either way, so the
    // request goes out without it rather than being blocked.
    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(1);
    expect(must(fetchCalls[0]).init.headers).not.toHaveProperty("Cookie");

    must(fixture.auth.cookieAuth).value = "sid-1";
    fixture.samplesAuthBox.checked = true;
    edit(fixture, fixture.samplesAuthBox, "change");
    await clickSend(fixture);
    // `Cookie` is a forbidden header name, so the send would arrive
    // unauthenticated; the sample, which a terminal can run, still carries it.
    expect(fetchCalls).toHaveLength(1);
    expect(fixture.response.textContent).toContain("`Cookie` header");
    expect(fixture.curlCode.textContent).toContain("Cookie: session=sid-1");
  });

  it("ignores a second click while a request is in flight", async () => {
    const fixture = createFixture(bearerModel());
    init(fixture);
    const gate = Promise.withResolvers<Response>();
    fetchImpl = () => gate.promise;
    const inFlight = clickSend(fixture);
    await clickSend(fixture);
    expect(fetchCalls).toHaveLength(1);
    expect(fixture.sendButton.disabled).toBe(true);
    gate.resolve(new Response("{}"));
    await inFlight;
    expect(fixture.sendButton.disabled).toBe(false);
  });
});

describe("remember on this device", () => {
  it("persists on check, follows edits, restores on init, clears on uncheck", () => {
    const fixture = createFixture(bearerModel());
    init(fixture);

    must(fixture.auth.bearerAuth).value = "tok-1";
    fixture.remember.checked = true;
    edit(fixture, fixture.remember, "change");
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? "")).toEqual({
      bearerAuth: { value: "tok-1" },
    });

    // Later credential edits keep the stored copy fresh while checked.
    must(fixture.auth.bearerAuth).value = "tok-2";
    edit(fixture, must(fixture.auth.bearerAuth));
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? "")).toEqual({
      bearerAuth: { value: "tok-2" },
    });

    // A fresh page (new DOM, same key) restores the value and the checkbox.
    const again = createFixture(bearerModel());
    init(again);
    expect(must(again.auth.bearerAuth).value).toBe("tok-2");
    expect(again.remember.checked).toBe(true);

    // Unchecking forgets; further edits must not resurrect the entry.
    again.remember.checked = false;
    edit(again, again.remember, "change");
    expect(storage.has(STORAGE_KEY)).toBe(false);
    must(again.auth.bearerAuth).value = "tok-3";
    edit(again, must(again.auth.bearerAuth));
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it("restores basic-auth pairs and skips ids missing from the entry", () => {
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        basicAuth: { password: "pw", username: "us", value: "" },
      })
    );
    const fixture = createFixture(basicModel());
    init(fixture);
    expect(must(fixture.auth["basicAuth:username"]).value).toBe("us");
    expect(must(fixture.auth["basicAuth:password"]).value).toBe("pw");
    expect(fixture.remember.checked).toBe(true);

    // Real values in samples after opt-in: RFC 7617 pair + query-borne key
    // placeholder (the reader typed no API key).
    fixture.samplesAuthBox.checked = true;
    edit(fixture, fixture.samplesAuthBox, "change");
    expect(fixture.curlCode.textContent).toContain(
      `Authorization: Basic ${btoa("us:pw")}`
    );
    expect(fixture.curlCode.textContent).toContain("api_key=YOUR_API_KEY");
  });

  it("drops a corrupt stored entry instead of breaking init", () => {
    storage.set(STORAGE_KEY, "{ nope");
    const fixture = createFixture(bearerModel());
    init(fixture);
    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect(fixture.remember.checked).toBe(false);
  });
});

describe("degenerate DOM", () => {
  it("does nothing without the model script", () => {
    expect(() => initPlayground(asElement(el("div")))).not.toThrow();
  });

  it("tolerates a panel with no inputs, no response region, no wrapper", async () => {
    const root = el("blume-playground", {});
    root.append(
      el(
        "script",
        { "data-playground-model": "", type: "application/json" },
        JSON.stringify(bearerModel())
      )
    );
    const sendButton = el("button", { "data-send": "" });
    root.append(sendButton);
    initPlayground(asElement(root));

    // Non-element event targets are ignored; element targets sync harmlessly.
    fire(root, "input", {});
    fire(root, "input", root);
    // No [data-response] region: send bails before fetching.
    await Promise.all(fire(sendButton, "click", sendButton));
    expect(fetchCalls).toHaveLength(0);
  });
});
