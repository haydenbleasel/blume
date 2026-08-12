/**
 * Client logic for the "Try it" playground panel, loaded lazily on the first
 * open of the `<details data-playground>` disclosure (see Playground.astro —
 * the custom-element loader lives there so this module stays import-safe in
 * tests). One request model drives everything: the same `buildRequest` output
 * feeds the live code samples, the copyable snippets, and the actual fetch, so
 * what a reader sends is byte-for-byte what the samples show.
 *
 * All response data is rendered through `textContent` — an API echoing HTML
 * back must never execute in the docs page.
 */

import type { AuthValue, PlaygroundModel, RequestValues } from "./request.ts";
import { buildRequest, redactAuth } from "./request.ts";
import { sampleLanguages } from "./snippets.ts";
import { validateJson } from "./validate-json.ts";

/**
 * A failed fetch surfaces as a TypeError with no status — almost always the
 * browser's CORS wall, not the API being down — so the message explains the
 * one fix docs authors control instead of parroting "failed to fetch".
 */
const CORS_MESSAGE =
  "The browser blocked this request before it reached the API — the API " +
  "likely does not allow cross-origin requests from this docs site. Set " +
  "`openapi.playground.proxy` in the Blume config to route playground " +
  "requests through the docs server instead.";

/** Convention used across the OpenAPI components for error-severity text. */
const ERROR_TEXT = "text-red-600 text-xs dark:text-red-400";

/**
 * Coerce a typed flat-body field's raw input text into its JSON value. Text
 * that doesn't parse as the declared type is kept verbatim so the API (not
 * the playground) reports the real validation error.
 */
const coerce = (raw: string, type: string): unknown => {
  if (type === "number" || type === "integer") {
    const numeric = Number(raw);
    return Number.isNaN(numeric) ? raw : numeric;
  }
  if (type === "boolean" && (raw === "true" || raw === "false")) {
    return raw === "true";
  }
  return raw;
};

/**
 * Pretty-print response text that parses as JSON; anything else (HTML error
 * pages, plain text) is shown verbatim.
 */
const prettyBody = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** A one-line text element for the response/error regions. */
const line = (className: string, text: string): HTMLElement => {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
};

/**
 * Wire the playground inside `root` (the `<blume-playground>` element). Reads
 * the server-rendered model JSON, keeps the request samples in sync with the
 * form, validates deep JSON bodies, and sends the request on demand.
 */
export const initPlayground = (root: HTMLElement): void => {
  const modelScript = root.querySelector("script[data-playground-model]");
  if (!modelScript) {
    return;
  }
  const model = JSON.parse(modelScript.textContent ?? "") as PlaygroundModel;

  // The sample panes live in the sibling RequestPanel, so they are looked up
  // from the shared operation-panel wrapper rather than this element.
  const scope = root.closest("[data-operation-panel]") ?? document;
  const panes = [...scope.querySelectorAll<HTMLElement>("[data-sample-lang]")];
  const languages = new Map(
    sampleLanguages(panes.map((pane) => pane.dataset.sampleLang ?? "")).map(
      (language) => [language.id, language]
    )
  );

  const serverSelect = root.querySelector<HTMLSelectElement>("[data-server]");
  const serverCustom = root.querySelector<HTMLInputElement>(
    "[data-server-custom]"
  );
  const paramInputs = [
    ...root.querySelectorAll<HTMLInputElement>("[data-param]"),
  ];
  const bodyArea = root.querySelector<HTMLTextAreaElement>("[data-body]");
  const bodyErrors = root.querySelector<HTMLElement>("[data-body-errors]");
  const remember = root.querySelector<HTMLInputElement>("[data-auth-remember]");
  const samplesAuth = root.querySelector<HTMLInputElement>(
    "[data-samples-auth]"
  );
  const sendButton = root.querySelector<HTMLButtonElement>("[data-send]");
  const response = root.querySelector<HTMLElement>("[data-response]");
  const storageKey = root.dataset.storageKey ?? "";
  const proxy = root.dataset.proxy ?? "";

  const field = (selector: string): HTMLInputElement | null =>
    root.querySelector<HTMLInputElement>(selector);

  /** Credentials straight from the inputs, keyed by security-scheme id. */
  const collectAuth = (): Record<string, AuthValue> => {
    const auth: Record<string, AuthValue> = {};
    for (const input of model.auth) {
      auth[input.id] =
        input.kind === "basic"
          ? {
              password:
                field(`[data-auth-password="${input.id}"]`)?.value ?? "",
              username:
                field(`[data-auth-username="${input.id}"]`)?.value ?? "",
              value: "",
            }
          : { value: field(`[data-auth-value="${input.id}"]`)?.value ?? "" };
    }
    return auth;
  };

  /**
   * Assemble the flat typed-fields UI into a JSON body. Empty optional fields
   * are omitted; empty required fields are kept (as "") so the API reports
   * the miss. No fields set at all means no body.
   */
  const flatBody = (): string | undefined => {
    const out: Record<string, unknown> = {};
    for (const spec of model.body?.fields ?? []) {
      const raw = field(`[data-body-field="${spec.name}"]`)?.value ?? "";
      if (raw === "" && !spec.required) {
        continue;
      }
      out[spec.name] = coerce(raw, spec.type);
    }
    return Object.keys(out).length > 0
      ? JSON.stringify(out, null, 2)
      : undefined;
  };

  /** The current form state as the shared RequestValues shape. */
  const collect = (): RequestValues => {
    const custom = serverCustom?.value.trim() ?? "";
    const params: Record<string, string> = {};
    for (const input of paramInputs) {
      params[input.dataset.param ?? ""] = input.value;
    }
    let body: string | undefined;
    if (bodyArea) {
      body = bodyArea.value;
    } else if (model.body?.fields) {
      body = flatBody();
    }
    return {
      auth: collectAuth(),
      body,
      params,
      server: custom || serverSelect?.value || model.servers[0] || "",
    };
  };

  /**
   * Re-render every request-sample pane from the live form. Credentials are
   * redacted to their placeholders unless the reader opted in — a copied
   * snippet must never leak a real token by accident.
   */
  const syncSamples = (): void => {
    const values = collect();
    const shown = samplesAuth?.checked ? values : redactAuth(model, values);
    const sample = buildRequest(model, shown);
    for (const pane of panes) {
      const language = languages.get(pane.dataset.sampleLang ?? "");
      if (!language) {
        continue;
      }
      const target = pane.querySelector("code") ?? pane;
      target.textContent = language.build(sample);
    }
  };

  /** Validate the raw JSON body and list the messages; [] when body-less. */
  const validateBody = (): string[] => {
    if (!(bodyArea && bodyErrors)) {
      return [];
    }
    const errors = validateJson(bodyArea.value, model.body?.schema);
    bodyErrors.textContent = "";
    for (const error of errors) {
      bodyErrors.append(line(ERROR_TEXT, error));
    }
    return errors;
  };

  /** Restore remembered credentials into the inputs and re-check the box. */
  const restoreAuth = (): void => {
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      return;
    }
    try {
      const saved = JSON.parse(stored) as Record<string, AuthValue>;
      for (const input of model.auth) {
        const value = saved[input.id];
        if (!value) {
          continue;
        }
        if (input.kind === "basic") {
          const username = field(`[data-auth-username="${input.id}"]`);
          const password = field(`[data-auth-password="${input.id}"]`);
          if (username) {
            username.value = value.username ?? "";
          }
          if (password) {
            password.value = value.password ?? "";
          }
        } else {
          const single = field(`[data-auth-value="${input.id}"]`);
          if (single) {
            single.value = value.value;
          }
        }
      }
      if (remember) {
        remember.checked = true;
      }
    } catch {
      // A corrupt entry (older format, manual edit) must not break init.
      localStorage.removeItem(storageKey);
    }
  };

  /** Render one settled HTTP exchange: status + time, headers, pretty body. */
  const renderResponse = (
    region: HTMLElement,
    res: Response,
    ms: number,
    text: string
  ): void => {
    region.textContent = "";
    region.append(
      line(
        "font-mono font-semibold text-foreground text-sm",
        `${res.status} ${res.statusText} \u00B7 ${ms} ms`.trim()
      )
    );
    const table = document.createElement("table");
    table.className = "w-full text-left text-xs";
    for (const [name, value] of res.headers) {
      const row = document.createElement("tr");
      const header = document.createElement("th");
      header.setAttribute("scope", "row");
      header.className = "pr-3 align-top font-medium text-muted-foreground";
      header.textContent = name;
      const cell = document.createElement("td");
      cell.className = "break-all font-mono text-foreground";
      cell.textContent = value;
      row.append(header, cell);
      table.append(row);
    }
    region.append(table);
    const pre = document.createElement("pre");
    pre.className =
      "overflow-x-auto rounded-blume border border-border p-3 font-mono text-foreground text-xs";
    const code = document.createElement("code");
    code.textContent = prettyBody(text);
    pre.append(code);
    region.append(pre);
  };

  /**
   * Send the real request. HTTP error statuses render like any response; only
   * a rejected fetch (the CORS wall) gets the explanatory message.
   */
  const send = async (): Promise<void> => {
    if (!response) {
      return;
    }
    if (validateBody().length > 0) {
      return;
    }
    const sample = buildRequest(model, collect());
    const url = proxy
      ? `${proxy}?url=${encodeURIComponent(sample.url)}`
      : sample.url;
    response.textContent = "Sending\u2026";
    const start = performance.now();
    try {
      const res = await fetch(url, {
        // fetch throws a synchronous TypeError for a GET/HEAD with a body —
        // which the catch below would mislabel as CORS. A spec that declares
        // a GET requestBody keeps its samples, but the live send drops it.
        body:
          sample.method === "GET" || sample.method === "HEAD"
            ? undefined
            : sample.body,
        headers: sample.headers,
        method: sample.method,
      });
      const ms = Math.round(performance.now() - start);
      renderResponse(response, res, ms, await res.text());
    } catch (error) {
      response.textContent = "";
      response.append(
        line(
          ERROR_TEXT,
          error instanceof TypeError
            ? CORS_MESSAGE
            : `Request failed: ${String(error)}`
        )
      );
    }
  };

  /**
   * One delegated edit handler for both `input` and `change`: revalidate the
   * body, maintain the remembered credentials, and re-sync the samples.
   * Running twice for events that fire both is harmless — every action here
   * is idempotent.
   */
  const onEdit = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (bodyArea && target === bodyArea) {
      validateBody();
    }
    if (remember && target === remember) {
      if (remember.checked) {
        localStorage.setItem(storageKey, JSON.stringify(collectAuth()));
      } else {
        localStorage.removeItem(storageKey);
      }
    } else if (
      remember?.checked &&
      (target.dataset.authValue !== undefined ||
        target.dataset.authUsername !== undefined ||
        target.dataset.authPassword !== undefined)
    ) {
      localStorage.setItem(storageKey, JSON.stringify(collectAuth()));
    }
    syncSamples();
  };

  restoreAuth();
  root.addEventListener("input", (event) => onEdit(event.target));
  root.addEventListener("change", (event) => onEdit(event.target));
  sendButton?.addEventListener("click", () => send());
};
