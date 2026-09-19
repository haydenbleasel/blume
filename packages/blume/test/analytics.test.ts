import { describe, expect, it } from "bun:test";

import { CLOUDFLARE_BEACON_SRC } from "../src/analytics/cloudflare.ts";
import { analyticsHead } from "../src/analytics/head.ts";
import { cloudflare, posthog, script, vercel } from "../src/analytics/index.ts";
import { POSTHOG_DEFAULT_HOST } from "../src/analytics/posthog.ts";
import { analyticsConfigSchema } from "../src/analytics/schema.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

describe("analytics adapter factories", () => {
  it("return serializable descriptors that survive a JSON round trip", () => {
    const adapters = [
      posthog({ key: "phc_test" }),
      vercel(),
      cloudflare({ token: "tok" }),
      script({ src: "https://x.test/a.js" }),
    ];
    // JSON on purpose, not structuredClone: the descriptor is written to the
    // generated data.json and read back, so JSON's semantics are the contract.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(adapters))).toEqual(adapters);
    expect(adapters.map((adapter) => adapter.kind)).toEqual([
      "posthog",
      "vercel",
      "cloudflare",
      "script",
    ]);
  });

  it("declare no runtime deps or secrets — the built-ins ship public tokens", () => {
    for (const adapter of [
      posthog({ key: "phc_test" }),
      vercel(),
      cloudflare({ token: "tok" }),
      script({ content: "noop()" }),
    ]) {
      expect(adapter.runtimeDeps).toEqual([]);
      expect(adapter.requiredSecrets).toEqual([]);
    }
  });

  it("keep the options verbatim, including ones Blume doesn't name", () => {
    const adapter = posthog({ key: "phc_test", persistence: "memory" });
    expect(adapter.options).toEqual({
      key: "phc_test",
      persistence: "memory",
    });
  });

  it("validate through the config schema", () => {
    const config = blumeConfigSchema.parse({
      analytics: [
        posthog({ key: "phc_test", persistence: "memory" }),
        vercel({ mode: "production" }),
        cloudflare({ spa: false, token: "tok" }),
        script({ src: "https://x.test/a.js" }),
      ],
    });
    expect(config.analytics).toHaveLength(4);
    expect(config.analytics[0]?.options).toMatchObject({
      persistence: "memory",
    });
    expect(config.analytics[2]?.options).toMatchObject({ spa: false });
  });
});

describe("analyticsConfigSchema", () => {
  it("defaults to an empty list", () => {
    expect(blumeConfigSchema.parse({}).analytics).toEqual([]);
  });

  it("rejects the pre-adapter object form with the list hint", () => {
    const result = analyticsConfigSchema.safeParse({ vercel: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      'imported from "blume/analytics"'
    );
  });

  it("keeps an adapter's own message for a bad option", () => {
    const result = analyticsConfigSchema.safeParse([
      script({ content: "x", src: "https://x.test/a.js" }),
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "exactly one of `src` or `content`"
    );
    expect(result.error?.issues[0]?.path).toEqual([0, "options"]);
  });

  it("rejects an unknown kind", () => {
    expect(
      analyticsConfigSchema.safeParse([
        {
          kind: "plausible",
          options: {},
          requiredSecrets: [],
          runtimeDeps: [],
        },
      ]).success
    ).toBe(false);
  });

  it("rejects an empty PostHog key and an unknown Vercel mode", () => {
    expect(
      analyticsConfigSchema.safeParse([posthog({ key: "" })]).success
    ).toBe(false);
    expect(
      analyticsConfigSchema.safeParse([
        { ...vercel(), options: { mode: "staging" } },
      ]).success
    ).toBe(false);
  });

  it("accepts nested JSON in a passthrough option", () => {
    const result = analyticsConfigSchema.safeParse([
      posthog({
        bootstrap: { featureFlags: { beta: true }, ids: [1, 2, null] },
        key: "k",
      }),
      cloudflare({ spa: false, token: "t" }),
      vercel({ endpoint: "https://va.example/api" }),
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects passthrough values JSON would drop or choke on, with a path", () => {
    const cases = [
      ["bigint", 10n],
      ["fn", () => 1],
      ["nan", Number.NaN],
      ["undefined", undefined],
    ] as const;
    for (const [name, value] of cases) {
      const result = analyticsConfigSchema.safeParse([
        { ...posthog({ key: "k" }), options: { key: "k", probe: value } },
      ]);
      expect(result.success, `${name} should be rejected`).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([0, "options", "probe"]);
    }
    expect(
      analyticsConfigSchema.safeParse([
        { ...vercel(), options: { beforeSend: () => null } },
      ]).success
    ).toBe(false);
    expect(
      analyticsConfigSchema.safeParse([
        {
          ...cloudflare({ token: "t" }),
          options: { spa: undefined, token: "t" },
        },
      ]).success
    ).toBe(false);
  });
});

describe("analyticsHead", () => {
  it("emits nothing for an empty list", () => {
    expect(analyticsHead([])).toEqual([]);
  });

  it("emits the PostHog loader with the key, the default host, and passthrough init options", () => {
    const nodes = analyticsHead([
      posthog({ key: "phc_test", persistence: "memory" }),
    ]);
    expect(nodes).toHaveLength(1);
    const [node] = nodes;
    expect(node?.type).toBe("script");
    if (node?.type !== "script") {
      throw new Error("expected a script node");
    }
    expect(node.attributes).toEqual({});
    expect(node.content).toContain("window.posthog=e");
    expect(node.content).toContain(
      `posthog.init("phc_test",{"api_host":"${POSTHOG_DEFAULT_HOST}","persistence":"memory"});`
    );
    // Client-router swaps count as pageviews.
    expect(node.content).toContain('addEventListener("astro:page-load"');
  });

  it("maps host to api_host and lets a raw api_host win", () => {
    const [eu] = analyticsHead([
      posthog({ host: "https://eu.i.posthog.com", key: "k" }),
    ]);
    expect(eu).toMatchObject({
      content: expect.stringContaining(
        '{"api_host":"https://eu.i.posthog.com"}'
      ),
    });
    const [raw] = analyticsHead([
      posthog({ api_host: "https://ph.example.com", key: "k" }),
    ]);
    expect(raw).toMatchObject({
      content: expect.stringContaining('{"api_host":"https://ph.example.com"}'),
    });
  });

  it("hands the Vercel component its props verbatim", () => {
    expect(
      analyticsHead([vercel({ debug: true, mode: "production" })])
    ).toEqual([{ props: { debug: true, mode: "production" }, type: "vercel" }]);
  });

  it("keeps the first vercel() in place and drops a second one", () => {
    const nodes = analyticsHead([
      script({ content: "window.webAnalyticsBeforeSend = (e) => e" }),
      vercel({ debug: true }),
      script({ src: "https://x.test/after.js" }),
      vercel(),
    ]);
    expect(nodes.map((node) => node.type)).toEqual([
      "script",
      "vercel",
      "script",
    ]);
    expect(nodes[1]).toEqual({ props: { debug: true }, type: "vercel" });
  });

  it("emits the Cloudflare beacon with the whole option object as data-cf-beacon", () => {
    expect(analyticsHead([cloudflare({ spa: false, token: "tok" })])).toEqual([
      {
        attributes: {
          "data-cf-beacon": '{"spa":false,"token":"tok"}',
          defer: true,
          src: CLOUDFLARE_BEACON_SRC,
        },
        content: null,
        type: "script",
      },
    ]);
  });

  it("emits an external script with its strategy and attributes", () => {
    const nodes = analyticsHead([
      script({
        attributes: { "data-domain": "example.com" },
        src: "https://plausible.io/js/script.js",
        strategy: "defer",
      }),
      script({ src: "https://x.test/a.js", strategy: "async" }),
      script({ src: "https://x.test/b.js" }),
    ]);
    expect(nodes).toEqual([
      {
        attributes: {
          "data-domain": "example.com",
          defer: true,
          src: "https://plausible.io/js/script.js",
        },
        content: null,
        type: "script",
      },
      {
        attributes: { async: true, src: "https://x.test/a.js" },
        content: null,
        type: "script",
      },
      {
        attributes: { src: "https://x.test/b.js" },
        content: null,
        type: "script",
      },
    ]);
  });

  it("lets an explicit src win over a same-named attribute", () => {
    const [node] = analyticsHead([
      script({
        attributes: { src: "https://old.test/x.js" },
        src: "https://x.test/a.js",
      }),
    ]);
    expect(node).toMatchObject({ attributes: { src: "https://x.test/a.js" } });
  });

  it("emits an inline script with its attributes", () => {
    expect(
      analyticsHead([
        script({ attributes: { id: "probe" }, content: "console.log(1)" }),
      ])
    ).toEqual([
      {
        attributes: { id: "probe" },
        content: "console.log(1)",
        type: "script",
      },
    ]);
  });

  it("keeps the adapters' declared order across kinds", () => {
    const nodes = analyticsHead([
      script({ src: "https://x.test/first.js" }),
      cloudflare({ token: "tok" }),
      vercel(),
      posthog({ key: "k" }),
      script({ content: "last()" }),
    ]);
    expect(
      nodes.map((node) => {
        if (node.type === "vercel") {
          return "vercel";
        }
        return node.content?.includes("posthog.init(")
          ? "posthog"
          : (node.attributes.src ?? node.content);
      })
    ).toEqual([
      "https://x.test/first.js",
      CLOUDFLARE_BEACON_SRC,
      "vercel",
      "posthog",
      "last()",
    ]);
  });
});
