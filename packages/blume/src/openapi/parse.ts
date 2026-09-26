import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type * as ConverterModule from "@asyncapi/converter";
import { normalize, upgrade } from "@scalar/openapi-parser";
import pRetry, { AbortError } from "p-retry";
import { isAbsolute, join } from "pathe";
import type * as UndiciModule from "undici";

import {
  commandsFor,
  detectProjectPackageManager,
} from "../cli/init/scaffold.ts";
import { nodeRequire } from "../core/node-require.ts";
import { hashText } from "../core/sources/cache.ts";
import type { AsyncApiDocument } from "./asyncapi.ts";
import { normalizeAsyncApiDocument } from "./asyncapi.ts";
import { buildGraphqlDocument } from "./graphql-build.ts";
import type { GraphqlDocument } from "./graphql.ts";
import type { ApiDocument } from "./model.ts";
import { applyOverlay, isJsonObject, overlayDocument } from "./overlay.ts";
import { SpecDependencyError } from "./spec-dependency-error.ts";

/**
 * Spec loading and normalization. Blume reuses Scalar's parser
 * (`@scalar/openapi-parser`) to read a spec (YAML or JSON), then upgrade Swagger
 * 2.0 / OpenAPI 3.0 documents to 3.1 so the renderer only handles one shape.
 * Internal `$ref`s are deliberately left in place (see `model.ts`).
 *
 * Remote (`http(s)`) specs are fetched defensively — bounded per attempt, retried
 * on transient failures, proxy-aware, and cached on disk — mirroring the
 * resilience the external link checker (`core/links.ts`) and the Notion source
 * (`core/sources/notion.ts`) already have. A bare `fetch` is the classic "curl
 * works but the build doesn't" gap: it ignores `*_PROXY`, has no timeout, and
 * dies on a single cold-start blip.
 */

const URL_SPEC = /^https?:\/\//u;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
// Honor Retry-After only up to a sane ceiling: a server answering with
// `Retry-After: 3600` must not stall a build for an hour per attempt.
const MAX_RETRY_WAIT_MS = 10_000;
const SECOND_MS = 1000;
// Worth another try: request timeout, too-early, rate-limited, and the 5xx range.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const USER_AGENT = "blume (+https://github.com/haydenbleasel/blume)";
const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

export interface ParsedSpec {
  document: ApiDocument;
  warnings: string[];
}

/**
 * The spec was read successfully but its contents aren't an OpenAPI document
 * (an empty file, or YAML that parses to a scalar or list — say, a README
 * pointed at by mistake). Kept distinct from read/fetch failures so callers
 * can suggest fixing the file instead of checking reachability.
 */
export class InvalidSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSpecError";
  }
}

/** Where and whether to cache a remote spec's text between runs. */
export interface SpecFetchOptions {
  /**
   * Overlay documents (local paths or `http(s)` URLs) applied in order to
   * the parsed spec, before it's upgraded. See `overlay.ts`.
   */
  overlays?: readonly string[];
  /** Dir for a last-good on-disk copy of a remote spec (offline fallback). */
  cacheDir?: string;
  /**
   * Re-fetch even when a cached copy exists. Builds/sync refresh; dev is
   * cache-first for fast, offline-tolerant restarts (see `SourceContext`).
   */
  refresh?: boolean;
}

/**
 * Route Node's global `fetch` through an HTTP(S) proxy the first time a remote
 * spec is fetched with one configured. Node's built-in `fetch` ignores `*_PROXY`
 * on its own; undici's env proxy agent, installed on the shared global-dispatcher
 * symbol, wires it in without replacing `fetch` (so tests can still stub it).
 * Best-effort and lazy: no proxy env means undici never loads, and an
 * unavailable undici just leaves the direct connection in place.
 */
let proxyInstalled = false;
const ensureProxyDispatcher = (): void => {
  // Only memoize a successful install: with no proxy configured we cheaply
  // re-check each time, so a proxy set later in the process still takes effect.
  if (proxyInstalled || !PROXY_ENV_VARS.some((name) => process.env[name])) {
    return;
  }
  try {
    // `require`, not `import()`: an ejected app scans in `astro:build:done`
    // (see `core/node-require.ts`).
    const { EnvHttpProxyAgent, setGlobalDispatcher }: typeof UndiciModule =
      nodeRequire("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    proxyInstalled = true;
  } catch {
    // No proxy support available; fall back to a direct connection.
  }
};

/**
 * `Retry-After` in ms when the server sent a sane one, else undefined. RFC
 * 9110 allows both forms: delta-seconds (`120`) and an HTTP-date (`Wed, 21
 * Oct 2015 07:28:00 GMT`); the date form arrives from CDN rate limiters and
 * was previously ignored.
 */
const retryAfterMs = (response: Response): number | undefined => {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * SECOND_MS : undefined;
  }
  const delta = Date.parse(header) - Date.now();
  return Number.isFinite(delta) && delta > 0 ? delta : undefined;
};

/** One fetch attempt, normalized: the body text, or a (maybe-retryable) error. */
type Attempt =
  | { text: string }
  | { error: Error; retryable: boolean; retryAfter?: number };

const attemptFetch = async (spec: string): Promise<Attempt> => {
  try {
    const response = await fetch(spec, {
      headers: {
        accept: "application/json, application/yaml, text/yaml, */*",
        "user-agent": USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      return { text: await response.text() };
    }
    return {
      error: new Error(`${spec} -> ${response.status} ${response.statusText}`),
      retryAfter: retryAfterMs(response),
      retryable: RETRYABLE_STATUS.has(response.status),
    };
  } catch (error) {
    // Network error, DNS/TLS failure, or an aborted (timed-out) request — all
    // transient by nature, so worth a retry.
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      retryable: true,
    };
  }
};

/**
 * A retryable failure, wrapped in a plain Error p-retry never special-cases:
 * it refuses to retry a non-network `TypeError`, and the underlying error's
 * type is the server's choice, not ours. The message is the underlying
 * error's, so the exhaustion throw still reads `spec -> 503 Service
 * Unavailable`.
 */
type RetryableFetchError = Error & { retryAfter?: number };

const retryableFetchError = (
  error: Error,
  retryAfter?: number
): RetryableFetchError => {
  const wrapper: RetryableFetchError = new Error(error.message, {
    cause: error,
  });
  wrapper.name = "RetryableFetchError";
  wrapper.retryAfter = retryAfter;
  return wrapper;
};

/** Fetch a remote spec's text, retrying transient failures with backoff. */
const fetchSpecText = async (spec: string): Promise<string> => {
  ensureProxyDispatcher();
  return await pRetry(
    async () => {
      const attempt = await attemptFetch(spec);
      if ("text" in attempt) {
        return attempt.text;
      }
      if (!attempt.retryable) {
        // AbortError stops retrying and rethrows the original untouched.
        throw new AbortError(attempt.error);
      }
      throw retryableFetchError(attempt.error, attempt.retryAfter);
    },
    {
      factor: 2,
      maxTimeout: MAX_RETRY_WAIT_MS,
      minTimeout: BASE_BACKOFF_MS,
      // A sane `Retry-After` replaces the exponential backoff rather than
      // stacking on it: p-retry's own (capped) delay still runs after this
      // hook, so only the difference is slept here.
      onFailedAttempt: async (context) => {
        // SAFETY: every retryable throw above is a RetryableFetchError; any
        // other error reaching this hook reads an absent retryAfter.
        const { retryAfter } = context.error as RetryableFetchError;
        if (retryAfter !== undefined && context.retriesLeft > 0) {
          await sleep(
            Math.max(
              0,
              Math.min(retryAfter, MAX_RETRY_WAIT_MS) - context.retryDelay
            )
          );
        }
      },
      retries: MAX_ATTEMPTS - 1,
    }
  );
};

const cacheFileFor = (cacheDir: string, spec: string): string =>
  join(cacheDir, `spec-${hashText(spec)}.cache`);

const readCache = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return undefined;
  }
};

const writeCache = async (
  dir: string,
  file: string,
  text: string
): Promise<void> => {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, text, "utf-8");
  } catch {
    // Best-effort cache; a write failure must not fail the load.
  }
};

/** Read a spec's raw text from an `http(s)` URL or a local (project-relative) path. */
const readSpecText = async (
  spec: string,
  root: string,
  options: SpecFetchOptions
): Promise<{ text: string; warnings: string[] }> => {
  if (!URL_SPEC.test(spec)) {
    const absolute = isAbsolute(spec) ? spec : join(root, spec);
    return { text: await readFile(absolute, "utf-8"), warnings: [] };
  }

  const cacheFile = options.cacheDir
    ? cacheFileFor(options.cacheDir, spec)
    : undefined;

  // Cache-first in dev: serve the last-good snapshot without touching the network.
  if (cacheFile && options.refresh === false) {
    const cached = await readCache(cacheFile);
    if (cached !== undefined) {
      return { text: cached, warnings: [] };
    }
  }

  try {
    const text = await fetchSpecText(spec);
    if (options.cacheDir && cacheFile) {
      await writeCache(options.cacheDir, cacheFile, text);
    }
    return { text, warnings: [] };
  } catch (error) {
    // A transient outage falls back to the last good fetch, with a warning.
    if (cacheFile) {
      const cached = await readCache(cacheFile);
      if (cached !== undefined) {
        // SAFETY: fetchSpecText throws only Error instances — attemptFetch
        // wraps every non-Error throw in an Error.
        return {
          text: cached,
          warnings: [
            `Could not fetch ${spec} (${(error as Error).message}); using the last cached copy.`,
          ],
        };
      }
    }
    throw error;
  }
};

/**
 * Read, normalize, and upgrade a spec to an OpenAPI 3.1 document. Throws when the
 * spec can't be read and no cache is available; callers turn that into a source
 * diagnostic (an error in build, a warning in dev) rather than a hard failure so
 * a broken spec doesn't take down the whole build.
 */
/**
 * A parsed mapping is the only shape the renderer can treat as a document:
 * `normalize` yields undefined for anything that isn't a YAML/JSON mapping
 * (empty file, scalar, list) and `upgrade(undefined)` a null specification.
 */
const isApiDocument = <Value>(value: Value): value is Value & ApiDocument =>
  typeof value === "object" && value !== null;

/**
 * Read a spec and apply its overlays, in order, to the parsed document as
 * written (before any upgrade: an overlay targets its spec's own version).
 * The overlays are read like the spec, local or remote, cached alike.
 */
const readOverlaid = async (
  spec: string,
  root: string,
  options: SpecFetchOptions
): Promise<{ document: ReturnType<typeof normalize>; warnings: string[] }> => {
  const [read, ...overlays] = await Promise.all(
    [spec, ...(options.overlays ?? [])].map((path) =>
      readSpecText(path, root, options)
    )
  );
  const document = normalize(read?.text ?? "");
  for (const [index, overlay] of overlays.entries()) {
    const name = options.overlays?.[index] ?? "";
    const parsed = overlayDocument(normalize(overlay.text), name);
    // A spec that isn't a mapping has nothing to overlay; the caller
    // rejects it as it would without overlays.
    if (isJsonObject(document)) {
      applyOverlay(document, parsed, name);
    }
  }
  return {
    document,
    warnings: [read, ...overlays].flatMap((entry) => entry?.warnings ?? []),
  };
};

/**
 * A spec with its overlays applied, as JSON text: what the Scalar embed
 * inlines, since it can't apply overlays itself.
 */
export const readOverlaidSpec = async (
  spec: string,
  root: string,
  options: SpecFetchOptions
): Promise<{ text: string; warnings: string[] }> => {
  const { document, warnings } = await readOverlaid(spec, root, options);
  return { text: JSON.stringify(document), warnings };
};

export const parseSpec = async (
  spec: string,
  root: string,
  options: SpecFetchOptions = {}
): Promise<ParsedSpec> => {
  const { document: normalized, warnings } = await readOverlaid(
    spec,
    root,
    options
  );
  const { specification } = upgrade(normalized);
  // Reject a non-mapping here so the renderer never sees a non-document.
  if (!isApiDocument(specification)) {
    throw new InvalidSpecError(
      `${spec} is not a valid OpenAPI document (expected a YAML or JSON object).`
    );
  }
  return { document: specification, warnings };
};

export interface ParsedAsyncApiSpec {
  document: AsyncApiDocument;
  warnings: string[];
}

/**
 * An object carrying a non-empty `asyncapi` version string — the only input
 * the converter and extractor can key on. `normalize` yields undefined for
 * non-mapping input, which fails the object check here.
 */
const isAsyncApiDocument = <Value>(
  value: Value
): value is Value & AsyncApiDocument & { asyncapi: string } =>
  typeof value === "object" &&
  value !== null &&
  "asyncapi" in value &&
  typeof value.asyncapi === "string" &&
  value.asyncapi !== "";

const CONVERTER = "@asyncapi/converter";

/**
 * Load `@asyncapi/converter`, an optional peer. Only a 1.x/2.x spec needs it,
 * and it depends on `@asyncapi/parser` — which it never loads — and so on
 * Spectral and Scarf's telemetry postinstall, an unapproved build script that
 * pnpm 12 refuses to install past. Leaving it out of a default install keeps
 * `pnpm dlx blume` working; a spec that needs it gets the install command
 * instead, through {@link SpecDependencyError}.
 */
const loadConverter = async (
  spec: string,
  version: string,
  root: string
): Promise<typeof ConverterModule> => {
  try {
    // `require`, not `import()`: see `core/node-require.ts`.
    const converter: typeof ConverterModule = nodeRequire(CONVERTER);
    return converter;
  } catch (error) {
    // SAFETY: a failed `require` throws a Node error; `code` and `message`
    // are the only fields read.
    const { code, message } = error as NodeJS.ErrnoException;
    // Only the converter itself missing is the project's to fix; anything
    // else (a broken install of one of its own dependencies) surfaces as is.
    if (code !== "MODULE_NOT_FOUND" || !message.includes(`'${CONVERTER}'`)) {
      throw error;
    }
    const { add } = commandsFor(await detectProjectPackageManager(root));
    throw new SpecDependencyError(
      `${spec} is AsyncAPI ${version}, and converting it to AsyncAPI 3.0 needs "${CONVERTER}", which isn't installed`,
      `Install it with \`${add} ${CONVERTER}\`, or convert the spec to AsyncAPI 3.0.`
    );
  }
};

/**
 * Read and normalize a spec to an AsyncAPI 3.x document — the AsyncAPI mirror
 * of {@link parseSpec}. 1.x/2.x documents are lifted to 3.0 with the official
 * `@asyncapi/converter` (channels + operations with `send`/`receive` actions),
 * so the extractor and components only ever handle one shape; `$ref`s stay
 * intact, matching the OpenAPI path. Error semantics match `parseSpec`: an
 * unreadable spec throws, a readable non-AsyncAPI document throws
 * {@link InvalidSpecError}, a pre-3.0 document without the converter installed
 * throws {@link SpecDependencyError}, and callers lower all three into source
 * diagnostics.
 */
export const parseAsyncApiSpec = async (
  spec: string,
  root: string,
  options: SpecFetchOptions = {}
): Promise<ParsedAsyncApiSpec> => {
  const { text, warnings } = await readSpecText(spec, root, options);
  const normalized = normalize(text);
  if (!isAsyncApiDocument(normalized)) {
    throw new InvalidSpecError(
      `${spec} is not a valid AsyncAPI document (expected a YAML or JSON object with an \`asyncapi\` version field).`
    );
  }
  const version = normalized.asyncapi;
  let document: AsyncApiDocument = normalized;
  if (!version.startsWith("3.")) {
    const { convert } = await loadConverter(spec, version, root);
    // The converter reports lossy conversions (e.g. a 2.x parameter schema
    // that 3.0 can't express) through console.warn — capture those as spec
    // warnings instead of letting them leak into CLI output.
    const captured: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      // SAFETY: the converter accepts any pre-3.0 AsyncAPI object and returns
      // the 3.0 shape the extractor consumes; the two packages just declare
      // the document type differently.
      document = convert(
        document as Parameters<typeof convert>[0],
        "3.0.0"
      ) as AsyncApiDocument;
    } catch (error) {
      // An unconvertible document (say, an unknown `asyncapi` version) is a
      // content problem, not a network one — same class as a non-document.
      // SAFETY: @asyncapi/converter throws Error instances for bad input.
      throw new InvalidSpecError(
        `${spec} could not be converted to AsyncAPI 3.0 (${(error as Error).message}).`
      );
    } finally {
      console.warn = originalWarn;
    }
    warnings.push(
      ...captured.map(
        (message) => `Converting ${spec} to AsyncAPI 3.0: ${message}`
      )
    );
  }
  return { document: normalizeAsyncApiDocument(document), warnings };
};

export interface ParsedGraphqlSpec {
  document: GraphqlDocument;
  warnings: string[];
}

/**
 * Read and lower a GraphQL schema — SDL text or an introspection JSON result —
 * to the serializable document the reference renders from; the GraphQL mirror
 * of {@link parseSpec}. Error semantics match the other kinds: an unreadable
 * spec throws the read/fetch error, while readable-but-invalid schema text
 * (SDL syntax errors, validation failures, JSON that isn't an introspection
 * result) throws {@link InvalidSpecError} so callers suggest fixing the file
 * rather than checking reachability.
 */
export const parseGraphqlSpec = async (
  spec: string,
  root: string,
  options: SpecFetchOptions = {}
): Promise<ParsedGraphqlSpec> => {
  const { text, warnings } = await readSpecText(spec, root, options);
  try {
    return { document: buildGraphqlDocument(text), warnings };
  } catch (error) {
    // SAFETY: `graphql`-js throws GraphQLError (an Error) for syntax and
    // validation failures, and `buildGraphqlDocument` throws plain Errors for
    // non-introspection JSON; only the message is surfaced.
    throw new InvalidSpecError(
      `${spec} is not a valid GraphQL schema (${(error as Error).message.trim()})`
    );
  }
};
