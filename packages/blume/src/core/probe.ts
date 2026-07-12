import type { DiagnosticSeverity } from "./types.ts";

export const PROBE_CONCURRENCY = 8;
export const PROBE_TIMEOUT_MS = 10_000;

const STATUS_NOT_FOUND = 404;
const STATUS_GONE = 410;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_NOT_IMPLEMENTED = 501;

/** The outcome of a single HTTP probe, with failures normalized rather than thrown. */
export interface ProbeResult {
  ok: boolean;
  status?: number;
  timedOut?: boolean;
  error?: string;
  /** Whether the request was redirected before landing on `status`. */
  redirected?: boolean;
  /** The URL finally landed on, after following redirects. */
  finalUrl?: string;
  /** `Content-Encoding` of the response, when the server set one. */
  encoding?: string | null;
  /** Wall-clock milliseconds for the request. */
  ms?: number;
  /** `X-Robots-Tag` of the response, when the server set one. */
  robotsTag?: string | null;
}

/** Probe a URL with the given method, normalizing failures to a result. */
const request = async (
  url: string,
  method: "GET" | "HEAD",
  timeoutMs: number
): Promise<ProbeResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
    });
    return {
      encoding: response.headers.get("content-encoding"),
      finalUrl: response.url,
      ms: Math.round(performance.now() - started),
      ok: response.ok,
      redirected: response.redirected,
      robotsTag: response.headers.get("x-robots-tag"),
      status: response.status,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, timedOut: true };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Probe a single URL: HEAD first, falling back to GET.
 *
 * Plenty of servers reject HEAD outright (405/501) or drop the connection, so a
 * HEAD-only probe would report healthy pages as dead.
 */
export const probe = async (
  url: string,
  options: { timeoutMs?: number } = {}
): Promise<ProbeResult> => {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const head = await request(url, "HEAD", timeoutMs);
  const unreachable = !head.ok && head.status === undefined && !head.timedOut;
  const retry =
    head.status === STATUS_METHOD_NOT_ALLOWED ||
    head.status === STATUS_NOT_IMPLEMENTED ||
    unreachable;
  return retry ? await request(url, "GET", timeoutMs) : head;
};

/** Grade a probe result into a severity + detail, or null when the URL is fine. */
export const gradeExternal = (
  result: ProbeResult
): { severity: DiagnosticSeverity; detail: string } | null => {
  if (result.ok) {
    return null;
  }
  if (result.timedOut) {
    return { detail: "request timed out", severity: "warning" };
  }
  if (result.status === undefined) {
    return { detail: result.error ?? "unreachable", severity: "error" };
  }
  // A 404/410 is definitively dead. A 403/429/5xx may well be rate limiting or a
  // transient blip, which is not the author's bug to fix.
  if (result.status === STATUS_NOT_FOUND || result.status === STATUS_GONE) {
    return { detail: `HTTP ${result.status}`, severity: "error" };
  }
  return { detail: `HTTP ${result.status}`, severity: "warning" };
};

/**
 * Probe many URLs with bounded concurrency, deduplicating first. Returns a map
 * from URL to its result — the caller decides what each one means.
 */
export const probeAll = async (
  urls: readonly string[],
  options: { concurrency?: number; timeoutMs?: number } = {}
): Promise<Map<string, ProbeResult>> => {
  const unique = [...new Set(urls)];
  const results = new Map<string, ProbeResult>();
  const limit = Math.min(
    options.concurrency ?? PROBE_CONCURRENCY,
    unique.length
  );

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const url = unique[cursor];
      cursor += 1;
      if (url !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- bounded-concurrency pool
        results.set(url, await probe(url, options));
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));

  return results;
};
