/**
 * The rate limit the generated server routes check before any work: the
 * assistant (`/api/ask`), the API playground proxy (`/_api-proxy`), and
 * server-side search. Each route builds one limiter at module scope from the
 * configured adapter (`rateLimit` in `blume.config.ts`) and asks it about
 * every request, keyed by the reader's IP address and the route, so each
 * route has its own budget.
 *
 * A limiter never stands between a reader and the docs by accident: a
 * request whose address the host can't tell is let through, and so is one
 * the shared store fails to count (logged, not blocked). A shared store
 * without its secrets or binding falls back to counting in memory.
 */
import { z } from "zod";

import { clientAddressOf } from "../core/client-address.ts";
import type { ClientContext } from "../core/client-address.ts";
import { RATE_LIMIT_BINDING } from "./cloudflare.ts";
import { DEFAULT_REQUESTS, DEFAULT_WINDOW } from "./memory.ts";
import type { RateLimitAdapter } from "./schema.ts";
import { UNKEY_MAX_WINDOW, UNKEY_NAMESPACE, unkeySecrets } from "./unkey.ts";
import { upstashSecrets } from "./upstash.ts";

/** What a limiter says about one request. */
export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the reader's window resets. */
  retryAfter: number;
}

/** Count one request against `key`. */
export type Limiter = (key: string) => Promise<RateLimitResult>;

/** A Workers rate limiting binding (`ratelimits` in the Worker's config). */
export interface RateLimitBinding {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

/** What a generated route hands the limiter from its runtime. */
export interface LimiterRuntime {
  /** The Worker's rate limiting binding, under `cloudflare()`. */
  binding?: RateLimitBinding;
  /** For tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** For tests; defaults to `Date.now`. */
  now?: () => number;
  /** Reads a secret (`getSecret` from `astro:env/server`). */
  secret?: (name: string) => string | undefined;
}

/** Past this many tracked readers, a memory limiter drops expired ones. */
const MEMORY_SWEEP_AT = 10_000;

/** One reader's count in the current window. */
interface MemoryEntry {
  count: number;
  resetAt: number;
}

/**
 * Count in this server's memory, in fixed windows: each reader's first
 * request opens a window, and the count resets when it ends.
 */
export const memoryLimiter = (
  requests: number,
  window: number,
  now: () => number = Date.now
): Limiter => {
  const entries = new Map<string, MemoryEntry>();
  return (key) => {
    const time = now();
    if (entries.size >= MEMORY_SWEEP_AT) {
      for (const [tracked, entry] of entries) {
        if (entry.resetAt <= time) {
          entries.delete(tracked);
        }
      }
    }
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + window * 1000 };
      entries.set(key, entry);
    }
    entry.count += 1;
    return Promise.resolve({
      allowed: entry.count <= requests,
      retryAfter: Math.ceil((entry.resetAt - time) / 1000),
    });
  };
};

/**
 * Counts the request and reads what's left of the window, run by Redis as
 * one step. A key without an expiry — the one `INCR` just created, or one a
 * failed call left behind — gets the window as its expiry, so a count can't
 * outlive its window and lock a reader out of the route for good. Separate
 * commands, even pipelined, let the key expire between them, and the `INCR`
 * after that created a key that never expired.
 */
export const UPSTASH_COUNT_SCRIPT = `local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

/** Upstash's REST reply to one command. */
interface UpstashReply {
  error?: string;
  result?: (number | null)[] | null;
}

/**
 * Count in Upstash Redis over its REST API: one `EVAL` of
 * {@link UPSTASH_COUNT_SCRIPT} counts the request, opens the window when it's
 * the first, and reads what's left of it.
 */
export const upstashLimiter = (
  requests: number,
  window: number,
  endpoint: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Limiter => {
  const url = endpoint.replace(/\/+$/u, "");
  return async (key) => {
    const response = await fetchImpl(url, {
      body: JSON.stringify([
        "EVAL",
        UPSTASH_COUNT_SCRIPT,
        "1",
        key,
        String(window),
      ]),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Upstash answered ${response.status}.`);
    }
    // SAFETY: Upstash's REST API answers a command with `{ result }`, here
    // the script's `{count, ttl}`; a missing or failed reply reads as `NaN`
    // below.
    const reply = (await response.json()) as UpstashReply;
    const count = Number(reply.result?.[0] ?? Number.NaN);
    const ttl = Number(reply.result?.[1]);
    if (Number.isNaN(count)) {
      throw new TypeError("Upstash sent no count.");
    }
    return { allowed: count <= requests, retryAfter: ttl > 0 ? ttl : window };
  };
};

/** Unkey's rate limit endpoint. */
const UNKEY_LIMIT_URL = "https://api.unkey.com/v2/ratelimit.limit";

/**
 * How long Unkey gets to count a request, in milliseconds, before the
 * request is let through without it.
 */
export const UNKEY_TIMEOUT = 2000;

/** The part of Unkey's reply the limiter reads. */
const unkeyReplySchema = z.object({
  data: z.object({
    overrideId: z.string().optional(),
    reset: z.number(),
    success: z.boolean(),
  }),
});

/**
 * Count with Unkey's rate limit API. Unkey takes identifiers of letters,
 * digits, and `_.:/-`, so anything else in the key (an IPv6 host's brackets,
 * an address's `%` zone) becomes `_`. Its `reset` is a timestamp on Unkey's
 * clock, which this server's may not match, so `retryAfter` is kept between
 * one second and the window: the configured one, or Unkey's longest when an
 * override set in Unkey replaced it.
 */
export const unkeyLimiter =
  (
    requests: number,
    window: number,
    namespace: string,
    rootKey: string,
    { fetch: fetchImpl = fetch, now = Date.now }: LimiterRuntime = {}
  ): Limiter =>
  async (key) => {
    const response = await fetchImpl(UNKEY_LIMIT_URL, {
      body: JSON.stringify({
        duration: window * 1000,
        identifier: key.replaceAll(/[^\w.:/-]/gu, "_"),
        limit: requests,
        namespace,
      }),
      headers: {
        authorization: `Bearer ${rootKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(UNKEY_TIMEOUT),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Unkey answered ${response.status}.`);
    }
    const { data } = unkeyReplySchema.parse(await response.json());
    const seconds = Math.ceil((data.reset - now()) / 1000);
    const longest = data.overrideId ? UNKEY_MAX_WINDOW : window;
    return {
      allowed: data.success,
      retryAfter: Math.min(longest, Math.max(1, seconds)),
    };
  };

/** Count with a Workers rate limiting binding. */
export const bindingLimiter =
  (binding: RateLimitBinding, window: number): Limiter =>
  async (key) => {
    const { success } = await binding.limit({ key });
    return { allowed: success, retryAfter: window };
  };

/** The limit an adapter sets, with Cloudflare's own defaults for its binding. */
const limitOf = (adapter: RateLimitAdapter) =>
  adapter.kind === "cloudflare"
    ? {
        requests: adapter.options.requests ?? 10,
        window: adapter.options.window ?? 60,
      }
    : {
        requests: adapter.options.requests ?? DEFAULT_REQUESTS,
        window: adapter.options.window ?? DEFAULT_WINDOW,
      };

/**
 * The limiter for the configured adapter, or `null` when rate limiting is
 * off. A shared store missing its secrets or binding counts in memory and
 * says so once.
 */
export const createLimiter = (
  adapter: RateLimitAdapter | null,
  runtime: LimiterRuntime = {}
): Limiter | null => {
  if (!adapter) {
    return null;
  }
  const { requests, window } = limitOf(adapter);
  if (adapter.kind === "unkey") {
    const [secret] = unkeySecrets(adapter.options);
    const rootKey = runtime.secret?.(secret);
    if (rootKey) {
      return unkeyLimiter(
        requests,
        window,
        adapter.options.namespace ?? UNKEY_NAMESPACE,
        rootKey,
        runtime
      );
    }
    console.warn(
      `Rate limiting counts in memory: set ${secret} to share the count through Unkey.`
    );
  }
  if (adapter.kind === "cloudflare") {
    if (runtime.binding) {
      return bindingLimiter(runtime.binding, window);
    }
    console.warn(
      `Rate limiting counts in memory: the Worker has no ${RATE_LIMIT_BINDING} binding.`
    );
  }
  if (adapter.kind === "upstash") {
    const secrets = upstashSecrets(adapter.options);
    const [endpoint, token] = secrets.map((name) => runtime.secret?.(name));
    if (endpoint && token) {
      return upstashLimiter(requests, window, endpoint, token, runtime.fetch);
    }
    console.warn(
      `Rate limiting counts in memory: set ${secrets.join(" and ")} to share the count through Upstash.`
    );
  }
  return memoryLimiter(requests, window, runtime.now);
};

/** The slice of Astro's `APIContext` the check reads. */
export type RateLimitContext = ClientContext;

/**
 * Count this request against the reader's budget for `scope` (the route).
 * `null` to go ahead, or the `429 Too Many Requests` to return.
 */
export const rateLimited = async (
  limiter: Limiter | null,
  context: RateLimitContext,
  scope: string
): Promise<Response | null> => {
  const address = limiter ? clientAddressOf(context) : undefined;
  if (!(limiter && address)) {
    return null;
  }
  // The host keeps two sites on one shared store apart.
  const key = `blume:${new URL(context.request.url).host}:${scope}:${address}`;
  let result: RateLimitResult;
  try {
    result = await limiter(key);
  } catch (error) {
    console.error("Rate limiting failed; letting the request through:", error);
    return null;
  }
  if (result.allowed) {
    return null;
  }
  return new Response(
    `Too many requests: try again in ${result.retryAfter} seconds.`,
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(result.retryAfter),
      },
      status: 429,
    }
  );
};
