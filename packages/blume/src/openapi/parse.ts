import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { normalize, upgrade } from "@scalar/openapi-parser";
import { isAbsolute, join } from "pathe";

import { hashText } from "../core/sources/cache.ts";
import type { ApiDocument } from "./model.ts";

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

/** Where and whether to cache a remote spec's text between runs. */
export interface SpecFetchOptions {
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
 * Best-effort and lazy: no proxy env means no undici import at all, and an
 * unavailable undici just leaves the direct connection in place.
 */
let proxyInstalled = false;
const ensureProxyDispatcher = async (): Promise<void> => {
  // Only memoize a successful install: with no proxy configured we cheaply
  // re-check each time, so a proxy set later in the process still takes effect.
  if (proxyInstalled || !PROXY_ENV_VARS.some((name) => process.env[name])) {
    return;
  }
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    proxyInstalled = true;
  } catch {
    // No proxy support available; fall back to a direct connection.
  }
};

/** `Retry-After` in ms when the server sent a sane one, else undefined. */
const retryAfterMs = (response: Response): number | undefined => {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * SECOND_MS
    : undefined;
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

/** Fetch a remote spec's text, retrying transient failures with backoff. */
const fetchSpecText = async (spec: string): Promise<string> => {
  await ensureProxyDispatcher();
  let last: Attempt = {
    error: new Error(`Could not fetch ${spec}`),
    retryable: false,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential retry attempts
    last = await attemptFetch(spec);
    if ("text" in last) {
      return last.text;
    }
    if (!last.retryable || attempt === MAX_ATTEMPTS - 1) {
      throw last.error;
    }
    // oxlint-disable-next-line no-await-in-loop -- back off before retrying
    await sleep(
      Math.min(
        last.retryAfter ?? BASE_BACKOFF_MS * 2 ** attempt,
        MAX_RETRY_WAIT_MS
      )
    );
  }
  throw last.error;
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
export const parseSpec = async (
  spec: string,
  root: string,
  options: SpecFetchOptions = {}
): Promise<ParsedSpec> => {
  const { text, warnings } = await readSpecText(spec, root, options);
  const normalized = normalize(text);
  const { specification } = upgrade(normalized);
  return { document: specification as ApiDocument, warnings };
};
