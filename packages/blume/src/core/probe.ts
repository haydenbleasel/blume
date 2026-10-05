import pMap from "p-map";

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
  /** The system error code behind a request that got no response (`ENOTFOUND`). */
  code?: string;
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

/**
 * The reason a request got no response. Node's fetch rejects with a bare
 * "fetch failed" and puts the system error (`getaddrinfo ENOTFOUND …`, with
 * its `code`) on `cause`; Bun's rejects with the system error itself.
 */
const failure = (error: Error): Pick<ProbeResult, "code" | "error"> => {
  const reason = error.cause instanceof Error ? error.cause : error;
  return "code" in reason
    ? { code: String(reason.code), error: reason.message }
    : { error: reason.message };
};

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
    const reason =
      error instanceof Error ? failure(error) : { error: String(error) };
    return { ...reason, ok: false };
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
  // No response at all. A host name that doesn't resolve is as dead as a 404;
  // a refused, reset, or failed connection is more often someone else's outage
  // or the runner's own network, so it's graded like a timeout.
  if (result.status === undefined) {
    return {
      detail: result.error ?? "unreachable",
      severity: result.code === "ENOTFOUND" ? "error" : "warning",
    };
  }
  // A 404/410 is definitively dead. Any other status — a 401/403 from a site
  // that turns bots away, a 429, a 5xx — may well be rate limiting or a
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
  const entries = await pMap(
    unique,
    async (url) => [url, await probe(url, options)] as const,
    { concurrency: Math.max(1, options.concurrency ?? PROBE_CONCURRENCY) }
  );
  return new Map(entries);
};
