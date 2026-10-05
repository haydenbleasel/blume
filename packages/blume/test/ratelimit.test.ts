import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { cloudflare as cloudflareDeploy } from "../src/deploy/adapters/index.ts";
import { cloudflare, memory, upstash } from "../src/ratelimit/index.ts";
import {
  bindingLimiter,
  createLimiter,
  memoryLimiter,
  rateLimited,
  UPSTASH_COUNT_SCRIPT,
  upstashLimiter,
} from "../src/ratelimit/runtime.ts";
import type { RateLimitContext } from "../src/ratelimit/runtime.ts";
import {
  rateLimitBinding,
  rateLimitNamespace,
  withRateLimitBinding,
} from "../src/ratelimit/wrangler.ts";

// Silenced per test and restored after, so no other suite sees the mocks.
let warn = spyOn(console, "warn");
let error = spyOn(console, "error");

beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

/** A request context from a reader at `address`. */
const from = (address?: string): RateLimitContext => ({
  clientAddress: address,
  request: new Request("https://docs.example.com/api/ask", { method: "POST" }),
});

/** A clock a test moves by hand. */
const clock = () => {
  let time = 1_000_000;
  return {
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
};

/** An Upstash REST stub whose script answers with `count` and `ttl`. */
const upstashStub = (count: number | null, ttl: number, ok = true) => {
  const calls: { body: string; headers: HeadersInit; url: string }[] = [];
  const stub = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: String(init?.body),
      headers: init?.headers ?? {},
      url: String(url),
    });
    return Promise.resolve(
      Response.json(
        { result: count === null ? null : [count, ttl] },
        { status: ok ? 200 : 500 }
      )
    );
  };
  // SAFETY: the limiter only calls `fetch(url, init)`, which the stub serves.
  return { calls, fetch: stub as typeof fetch };
};

describe("rate limit adapters", () => {
  it("return plain descriptors, and only Upstash names secrets", () => {
    expect(memory()).toStrictEqual({
      kind: "memory",
      options: {},
      requiredSecrets: [],
      runtimeDeps: [],
    });
    expect(upstash({ requests: 5 }).requiredSecrets).toStrictEqual([
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]);
    // Vercel's Marketplace names them its own way.
    expect(
      upstash({ tokenEnv: "KV_REST_API_TOKEN", urlEnv: "KV_REST_API_URL" })
        .requiredSecrets
    ).toStrictEqual(["KV_REST_API_URL", "KV_REST_API_TOKEN"]);
    expect(cloudflare({ window: 10 }).options).toStrictEqual({ window: 10 });
  });

  it("is on by default with memory(), and off with false", () => {
    expect(blumeConfigSchema.parse({}).rateLimit).toStrictEqual(memory());
    expect(blumeConfigSchema.parse({ rateLimit: false }).rateLimit).toBeNull();
    expect(
      blumeConfigSchema.parse({ rateLimit: upstash() }).rateLimit
    ).toStrictEqual(upstash());
    const marketplace = upstash({ urlEnv: "KV_REST_API_URL" });
    expect(
      blumeConfigSchema.parse({ rateLimit: marketplace }).rateLimit
    ).toStrictEqual(marketplace);
    expect(
      blumeConfigSchema.safeParse({ rateLimit: upstash({ tokenEnv: "" }) })
        .error?.issues[0]?.path
    ).toStrictEqual(["rateLimit", "options", "tokenEnv"]);
  });

  it("points anything else at blume/ratelimit, and keeps option errors", () => {
    for (const rateLimit of [true, "memory", { kind: "redis" }]) {
      const result = blumeConfigSchema.safeParse({ rateLimit });
      expect(result.error?.issues[0]?.message).toContain('"blume/ratelimit"');
    }
    const negative = blumeConfigSchema.safeParse({
      rateLimit: memory({ requests: -1 }),
    });
    expect(negative.error?.issues[0]?.path).toStrictEqual([
      "rateLimit",
      "options",
      "requests",
    ]);
    const window = blumeConfigSchema.safeParse({
      deployment: cloudflareDeploy(),
      // SAFETY: an out-of-range window, as a JavaScript config could pass it.
      rateLimit: cloudflare({ window: 30 as 10 }),
    });
    expect(window.success).toBe(false);
  });

  it("needs a Cloudflare deployment for cloudflare()", () => {
    const elsewhere = blumeConfigSchema.safeParse({ rateLimit: cloudflare() });
    expect(elsewhere.error?.issues[0]?.path).toStrictEqual(["rateLimit"]);
    expect(elsewhere.error?.issues[0]?.message).toContain(
      "deployment: cloudflare()"
    );
    expect(
      blumeConfigSchema.safeParse({
        deployment: cloudflareDeploy(),
        rateLimit: cloudflare(),
      }).success
    ).toBe(true);
  });
});

describe(memoryLimiter, () => {
  it("allows a reader's requests up to the limit, then until the window ends", async () => {
    const time = clock();
    const limit = memoryLimiter(2, 60, time.now);
    expect(await limit("a")).toStrictEqual({ allowed: true, retryAfter: 60 });
    time.advance(15_500);
    expect(await limit("a")).toStrictEqual({ allowed: true, retryAfter: 45 });
    expect(await limit("a")).toStrictEqual({ allowed: false, retryAfter: 45 });
    // Each reader has their own count.
    expect(await limit("b")).toMatchObject({ allowed: true });
    time.advance(45_000);
    expect(await limit("a")).toMatchObject({ allowed: true });
  });

  it("drops readers whose window ended once it tracks many", async () => {
    const time = clock();
    const limit = memoryLimiter(1, 1, time.now);
    for (let reader = 0; reader < 10_000; reader += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one reader at a time, like requests
      await limit(`reader-${reader}`);
    }
    time.advance(2000);
    await limit("fresh");
    // The first reader's window was swept, so it starts over.
    expect(await limit("reader-0")).toStrictEqual({
      allowed: true,
      retryAfter: 1,
    });
  });
});

describe(upstashLimiter, () => {
  it("counts in one script and reads the window's remaining seconds", async () => {
    const stub = upstashStub(4, 42);
    const limit = upstashLimiter(
      3,
      600,
      "https://eu.upstash.io/",
      "t0k",
      stub.fetch
    );
    expect(await limit("k")).toStrictEqual({ allowed: false, retryAfter: 42 });
    expect(stub.calls[0]?.url).toBe("https://eu.upstash.io");
    // One command, which Redis runs as one step: the key can't expire
    // between counting and reading it, and come back with no expiry.
    expect(JSON.parse(stub.calls[0]?.body ?? "")).toStrictEqual([
      "EVAL",
      UPSTASH_COUNT_SCRIPT,
      "1",
      "k",
      "600",
    ]);
    // A key without an expiry, new or left behind, gets the window.
    expect(UPSTASH_COUNT_SCRIPT).toContain("if ttl < 0 then");
    expect(UPSTASH_COUNT_SCRIPT).toContain(
      'redis.call("EXPIRE", KEYS[1], ARGV[1])'
    );
    expect(stub.calls[0]?.headers).toMatchObject({
      authorization: "Bearer t0k",
    });
  });

  it("falls back to the window when no whole second is left", async () => {
    const limit = upstashLimiter(
      3,
      600,
      "https://x",
      "t",
      upstashStub(1, 0).fetch
    );
    expect(await limit("k")).toStrictEqual({ allowed: true, retryAfter: 600 });
  });

  it("throws on a failed or empty reply", async () => {
    const failed = upstashLimiter(
      3,
      600,
      "https://x",
      "t",
      upstashStub(1, 1, false).fetch
    );
    await expect(failed("k")).rejects.toThrow("Upstash answered 500.");
    const empty = upstashLimiter(
      3,
      600,
      "https://x",
      "t",
      upstashStub(null, 1).fetch
    );
    await expect(empty("k")).rejects.toThrow("Upstash sent no count.");
  });
});

describe(bindingLimiter, () => {
  it("asks the Workers binding, keyed by reader", async () => {
    const keys: string[] = [];
    const limit = bindingLimiter(
      {
        limit: ({ key }) => {
          keys.push(key);
          return Promise.resolve({ success: keys.length < 2 });
        },
      },
      60
    );
    expect(await limit("a")).toStrictEqual({ allowed: true, retryAfter: 60 });
    expect(await limit("a")).toStrictEqual({ allowed: false, retryAfter: 60 });
    expect(keys).toStrictEqual(["a", "a"]);
  });
});

describe(createLimiter, () => {
  it("is null when rate limiting is off", () => {
    expect(createLimiter(null)).toBeNull();
  });

  it("uses each adapter's store and limits", async () => {
    const time = clock();
    const counted = createLimiter(memory({ requests: 1, window: 5 }), {
      now: time.now,
    });
    expect(await counted?.("a")).toStrictEqual({
      allowed: true,
      retryAfter: 5,
    });
    const shared = createLimiter(upstash(), {
      fetch: upstashStub(31, 100).fetch,
      secret: (name) => `${name}-value`,
    });
    // The default: 30 requests per 10 minutes.
    expect(await shared?.("a")).toStrictEqual({
      allowed: false,
      retryAfter: 100,
    });
    const bound = createLimiter(cloudflare(), {
      binding: { limit: () => Promise.resolve({ success: true }) },
    });
    expect(await bound?.("a")).toStrictEqual({ allowed: true, retryAfter: 60 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads Upstash's secrets from the env vars the adapter names", async () => {
    const stub = upstashStub(1, 100);
    const read: string[] = [];
    const marketplace = createLimiter(
      upstash({ tokenEnv: "KV_REST_API_TOKEN", urlEnv: "KV_REST_API_URL" }),
      {
        fetch: stub.fetch,
        secret: (name) => {
          read.push(name);
          return name.startsWith("KV_") ? `${name}-value` : undefined;
        },
      }
    );
    expect(await marketplace?.("a")).toMatchObject({ allowed: true });
    expect(read).toStrictEqual(["KV_REST_API_URL", "KV_REST_API_TOKEN"]);
    expect(stub.calls[0]?.url).toBe("KV_REST_API_URL-value");
    expect(stub.calls[0]?.headers).toMatchObject({
      authorization: "Bearer KV_REST_API_TOKEN-value",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("counts in memory, and says so, when a shared store isn't set up", async () => {
    const time = clock();
    const noSecrets = createLimiter(upstash({ requests: 1 }), {
      now: time.now,
      secret: () => {},
    });
    expect(await noSecrets?.("a")).toMatchObject({ allowed: true });
    expect(await noSecrets?.("a")).toMatchObject({ allowed: false });
    const noBinding = createLimiter(cloudflare({ requests: 1, window: 10 }));
    expect(await noBinding?.("a")).toMatchObject({ retryAfter: 10 });
    createLimiter(upstash({ urlEnv: "KV_REST_API_URL" }), { secret: () => {} });
    expect(warn.mock.calls.map(([message]) => String(message))).toStrictEqual([
      "Rate limiting counts in memory: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to share the count through Upstash.",
      "Rate limiting counts in memory: the Worker has no BLUME_RATE_LIMIT binding.",
      "Rate limiting counts in memory: set KV_REST_API_URL and UPSTASH_REDIS_REST_TOKEN to share the count through Upstash.",
    ]);
  });
});

/** A limiter that refuses everyone. */
const refuseAll = () => Promise.resolve({ allowed: false, retryAfter: 1 });

/** A limiter whose store is down. */
const storeDown = () => Promise.reject(new Error("store down"));

describe(rateLimited, () => {
  it("lets every request through when rate limiting is off", async () => {
    expect(await rateLimited(null, from("1.2.3.4"), "ask")).toBeNull();
  });

  it("answers 429 with Retry-After once the reader is over the limit", async () => {
    const keys: string[] = [];
    const limit = (key: string) => {
      keys.push(key);
      return Promise.resolve({ allowed: keys.length < 2, retryAfter: 30 });
    };
    expect(await rateLimited(limit, from("1.2.3.4"), "ask")).toBeNull();
    const blocked = await rateLimited(limit, from("1.2.3.4"), "ask");
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBe("30");
    expect(await blocked?.text()).toBe(
      "Too many requests: try again in 30 seconds."
    );
    expect(keys[0]).toBe("blume:docs.example.com:ask:1.2.3.4");
  });

  it("lets through a reader the host can't identify", async () => {
    const limit = refuseAll;
    expect(await rateLimited(limit, from(), "ask")).toBeNull();
    expect(await rateLimited(limit, from(""), "ask")).toBeNull();
    const unknown: RateLimitContext = {
      get clientAddress(): string {
        throw new Error("clientAddress is not available");
      },
      request: new Request("https://docs.example.com/api/ask"),
    };
    expect(await rateLimited(limit, unknown, "ask")).toBeNull();
  });

  it("lets the request through, and logs, when the store fails", async () => {
    expect(await rateLimited(storeDown, from("1.2.3.4"), "search")).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("the Workers binding", () => {
  it("derives a stable namespace per Worker", () => {
    const id = rateLimitNamespace("acme-docs");
    expect(id).toMatch(/^[1-9]\d*$/u);
    expect(rateLimitNamespace("acme-docs")).toBe(id);
    expect(rateLimitNamespace("other-docs")).not.toBe(id);
  });

  it("declares the configured limit, or Cloudflare's defaults", () => {
    expect(rateLimitBinding(cloudflare(), "acme-docs")).toStrictEqual({
      name: "BLUME_RATE_LIMIT",
      namespace_id: rateLimitNamespace("acme-docs"),
      simple: { limit: 10, period: 60 },
    });
    expect(
      rateLimitBinding(
        cloudflare({ namespaceId: "7", requests: 3, window: 10 }),
        "acme-docs"
      )
    ).toStrictEqual({
      name: "BLUME_RATE_LIMIT",
      namespace_id: "7",
      simple: { limit: 3, period: 10 },
    });
  });

  it("replaces an earlier binding and keeps the Worker's others", () => {
    const wrangler = JSON.stringify({
      main: "index.js",
      name: "acme-docs",
      ratelimits: [
        { name: "OTHER", namespace_id: "1" },
        { name: "BLUME_RATE_LIMIT", namespace_id: "2" },
      ],
    });
    const bound = JSON.parse(
      withRateLimitBinding(wrangler, cloudflare({ namespaceId: "9" })) ?? ""
    );
    expect(bound.ratelimits).toStrictEqual([
      { name: "OTHER", namespace_id: "1" },
      {
        name: "BLUME_RATE_LIMIT",
        namespace_id: "9",
        simple: { limit: 10, period: 60 },
      },
    ]);
    expect(bound.main).toBe("index.js");
    const unnamed = JSON.parse(withRateLimitBinding("{}", cloudflare()) ?? "");
    expect(unnamed.ratelimits[0].namespace_id).toBe(rateLimitNamespace(""));
  });

  it("gives up on a config that isn't a JSON object", () => {
    expect(withRateLimitBinding("not json", cloudflare())).toBeNull();
    expect(withRateLimitBinding("[1]", cloudflare())).toBeNull();
    expect(withRateLimitBinding("null", cloudflare())).toBeNull();
  });
});
