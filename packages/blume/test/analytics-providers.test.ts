import { describe, expect, it } from "bun:test";

import {
  AMPLITUDE_DEFAULT_INIT,
  AMPLITUDE_SCRIPT_ORIGIN,
} from "../src/analytics/amplitude.ts";
import { CLEARBIT_TAG_ORIGIN } from "../src/analytics/clearbit.ts";
import { DATABUDDY_SCRIPT_SRC } from "../src/analytics/databuddy.ts";
import { FATHOM_SCRIPT_SRC } from "../src/analytics/fathom.ts";
import { GOOGLE_TAG_SRC } from "../src/analytics/google-analytics.ts";
import type { HeadScript } from "../src/analytics/head.ts";
import { analyticsHead } from "../src/analytics/head.ts";
import { HIGHTOUCH_DEFAULT_HOST } from "../src/analytics/hightouch.ts";
import { HOTJAR_DEFAULT_VERSION } from "../src/analytics/hotjar.ts";
import {
  adobe,
  amplitude,
  clarity,
  clearbit,
  databuddy,
  fathom,
  googleAnalytics,
  googleTagManager,
  heap,
  hightouch,
  hotjar,
  logrocket,
  mixpanel,
  pirsch,
  plausible,
  segment,
} from "../src/analytics/index.ts";
import { LOGROCKET_SCRIPT_SRC } from "../src/analytics/logrocket.ts";
import { MIXPANEL_REGION_HOSTS } from "../src/analytics/mixpanel.ts";
import { PIRSCH_SCRIPT_SRC } from "../src/analytics/pirsch.ts";
import { PLAUSIBLE_QUEUE } from "../src/analytics/plausible.ts";
import { analyticsConfigSchema } from "../src/analytics/schema.ts";
import { SEGMENT_DEFAULT_CDN } from "../src/analytics/segment.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

// Every provider adapter with the smallest valid call, in the order the docs
// list them.
const all = () => [
  adobe({ url: "https://assets.adobedtm.com/x/launch-y.min.js" }),
  amplitude({ key: "amp" }),
  clarity({ id: "abc123" }),
  clearbit({ key: "pk_1a1882" }),
  databuddy({ clientId: "client" }),
  fathom({ site: "YSVMSDAY" }),
  googleAnalytics({ id: "G-XXXX" }),
  googleTagManager({ id: "GTM-XXXX" }),
  heap({ id: "1234567890" }),
  hightouch({ key: "wk" }),
  hotjar({ id: 1234 }),
  logrocket({ id: "org/app" }),
  mixpanel({ token: "tok" }),
  pirsch({ code: "code" }),
  plausible({ domain: "docs.example.com" }),
  segment({ key: "wk" }),
];

/** The script tags `analyticsHead` emits for one adapter. */
const scripts = (adapter: ReturnType<typeof all>[number]): HeadScript[] =>
  analyticsHead([adapter]).map((node) => {
    if (node.type !== "script") {
      throw new Error("expected a script node");
    }
    return { attributes: node.attributes, content: node.content };
  });

describe("provider adapter factories", () => {
  it("return serializable descriptors with public tokens and no runtime deps", () => {
    const adapters = all();
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(adapters))).toEqual(adapters);
    expect(adapters.map((adapter) => adapter.kind)).toEqual([
      "adobe",
      "amplitude",
      "clarity",
      "clearbit",
      "databuddy",
      "fathom",
      "google-analytics",
      "google-tag-manager",
      "heap",
      "hightouch",
      "hotjar",
      "logrocket",
      "mixpanel",
      "pirsch",
      "plausible",
      "segment",
    ]);
    for (const adapter of adapters) {
      expect(adapter.runtimeDeps).toEqual([]);
      expect(adapter.requiredSecrets).toEqual([]);
    }
  });

  it("validate through the config schema, passthrough included", () => {
    const config = blumeConfigSchema.parse({
      analytics: [
        ...all(),
        amplitude({ key: "amp", serverZone: "EU" }),
        fathom({ site: "S", spa: "auto" }),
        mixpanel({ persistence: "localStorage", region: "eu", token: "t" }),
        databuddy({ clientId: "c", "track-web-vitals": "true" }),
      ],
    });
    expect(config.analytics).toHaveLength(20);
    expect(config.analytics[16]?.options).toMatchObject({ serverZone: "EU" });
    expect(config.analytics[17]?.options).toMatchObject({ spa: "auto" });
    expect(config.analytics[18]?.options).toMatchObject({ region: "eu" });
    expect(config.analytics[19]?.options).toMatchObject({
      "track-web-vitals": "true",
    });
  });

  it("reject an empty identifier on every adapter", () => {
    const empties = [
      adobe({ url: "" }),
      amplitude({ key: "" }),
      clarity({ id: "" }),
      clearbit({ key: "" }),
      databuddy({ clientId: "" }),
      fathom({ site: "" }),
      googleAnalytics({ id: "" }),
      googleTagManager({ id: "" }),
      heap({ id: "" }),
      hightouch({ key: "" }),
      logrocket({ id: "" }),
      mixpanel({ token: "" }),
      pirsch({ code: "" }),
      plausible({ domain: "" }),
      segment({ key: "" }),
    ];
    for (const adapter of empties) {
      const result = analyticsConfigSchema.safeParse([adapter]);
      expect(result.success, `${adapter.kind} should reject ""`).toBe(false);
    }
  });

  it("reject a non-string data attribute, an unknown region, and a fractional Hotjar id", () => {
    expect(
      analyticsConfigSchema.safeParse([
        { ...fathom({ site: "S" }), options: { site: "S", spa: true } },
      ]).success
    ).toBe(false);
    expect(
      analyticsConfigSchema.safeParse([
        {
          ...databuddy({ clientId: "c" }),
          options: { clientId: "c", "track-errors": true },
        },
      ]).success
    ).toBe(false);
    expect(
      analyticsConfigSchema.safeParse([
        { ...mixpanel({ token: "t" }), options: { region: "ap", token: "t" } },
      ]).success
    ).toBe(false);
    expect(analyticsConfigSchema.safeParse([hotjar({ id: 1.5 })]).success).toBe(
      false
    );
    expect(
      analyticsConfigSchema.safeParse([
        { ...hotjar({ id: 1 }), options: { id: 1, probe: 2 } },
      ]).success
    ).toBe(false);
  });
});

describe("provider adapter heads", () => {
  it("adobe: the async Launch embed", () => {
    expect(
      scripts(adobe({ url: "https://assets.adobedtm.com/x/launch-y.min.js" }))
    ).toEqual([
      {
        attributes: {
          async: true,
          src: "https://assets.adobedtm.com/x/launch-y.min.js",
        },
        content: null,
      },
    ]);
  });

  it("amplitude: the keyed SDK bundle and an init call with the snippet's defaults under passthrough", () => {
    const [sdk, init] = scripts(amplitude({ autocapture: false, key: "a/b" }));
    expect(sdk).toEqual({
      attributes: { src: `${AMPLITUDE_SCRIPT_ORIGIN}a%2Fb.js` },
      content: null,
    });
    expect(init?.content).toBe(
      `window.amplitude.init("a/b",${JSON.stringify({ ...AMPLITUDE_DEFAULT_INIT, autocapture: false })});`
    );
  });

  it("clarity: the tracking code with the project id", () => {
    const [tag] = scripts(clarity({ id: "abc 123" }));
    expect(tag?.attributes).toEqual({});
    expect(tag?.content).toContain('"https://www.clarity.ms/tag/"+i');
    expect(tag?.content).toContain('"clarity","script","abc%20123")');
  });

  it("clearbit: the keyed tag with its referrer policy", () => {
    expect(scripts(clearbit({ key: "pk_1a1882" }))).toEqual([
      {
        attributes: {
          referrerpolicy: "strict-origin-when-cross-origin",
          src: `${CLEARBIT_TAG_ORIGIN}pk_1a1882/tags.js`,
        },
        content: null,
      },
    ]);
  });

  it("fathom: tracks history changes by default, unless spa is set", () => {
    const [tag] = scripts(fathom({ site: "YSVMSDAY" }));
    expect(tag?.attributes["data-spa"]).toBe("auto");
    const [pinned] = scripts(fathom({ site: "YSVMSDAY", spa: "history" }));
    expect(pinned?.attributes["data-spa"]).toBe("history");
  });

  it("fathom: the deferred tag with data-site and passthrough data attributes", () => {
    expect(
      scripts(fathom({ "honor-dnt": "true", site: "YSVMSDAY", spa: "auto" }))
    ).toEqual([
      {
        attributes: {
          "data-honor-dnt": "true",
          "data-site": "YSVMSDAY",
          "data-spa": "auto",
          defer: true,
          src: FATHOM_SCRIPT_SRC,
        },
        content: null,
      },
    ]);
  });

  it("google-analytics: the async loader and the bare config call", () => {
    const [loader, boot] = scripts(googleAnalytics({ id: "G-X Y" }));
    expect(loader).toEqual({
      attributes: { async: true, src: `${GOOGLE_TAG_SRC}?id=G-X%20Y` },
      content: null,
    });
    expect(boot?.content).toBe(
      'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","G-X Y");'
    );
  });

  it("google-analytics: passthrough parameters ride on the config call", () => {
    const [, boot] = scripts(
      googleAnalytics({ id: "G-X", send_page_view: false })
    );
    expect(boot?.content).toContain(
      'gtag("config","G-X",{"send_page_view":false});'
    );
  });

  it("google-tag-manager: the container snippet with the default and a custom data layer", () => {
    const [tag] = scripts(googleTagManager({ id: "GTM-X" }));
    expect(tag?.content).toContain(
      '(window,document,"script","dataLayer","GTM-X");'
    );
    expect(tag?.content).toContain(
      '"https://www.googletagmanager.com/gtm.js?id="+i+dl'
    );
    const [custom] = scripts(
      googleTagManager({ dataLayer: "dl", id: "GTM-X" })
    );
    expect(custom?.content).toContain('"script","dl","GTM-X");');
    // The layer is kept so `track()` pushes where the container reads.
    expect(custom?.content).toContain("w[l]=w[l]||[];w.__blumeGtmLayer=w[l];");
  });

  it("heap: the loader and heap.load, bare or with the passthrough config", () => {
    const [bare] = scripts(heap({ id: "123" }));
    expect(bare?.content).toContain('heap-"+e+".js');
    expect(bare?.content).toEndWith('heap.load("123");');
    const [configured] = scripts(heap({ id: "123", secureCookie: true }));
    expect(configured?.content).toEndWith(
      'heap.load("123",{"secureCookie":true});'
    );
  });

  it("hightouch: the loader with the default host, a custom host, and SPA pageviews", () => {
    const [tag] = scripts(hightouch({ key: "wk" }));
    expect(tag?.content).toContain(
      `e.load("wk",{"apiHost":"${HIGHTOUCH_DEFAULT_HOST}"}),e.page()`
    );
    expect(tag?.content).toContain("htevents.page();");
    expect(tag?.content).toContain("__blumeHightouchPath");
    const [custom] = scripts(
      hightouch({ host: "eu.example", key: "wk", probe: 1 })
    );
    expect(custom?.content).toContain(
      'e.load("wk",{"apiHost":"eu.example","probe":1})'
    );
  });

  it("hotjar: the tracking code with the id and the default or given version", () => {
    const [tag] = scripts(hotjar({ id: 1234 }));
    expect(tag?.content).toContain(
      `h._hjSettings={hjid:1234,hjsv:${HOTJAR_DEFAULT_VERSION}};`
    );
    const [versioned] = scripts(hotjar({ id: 1234, version: 7 }));
    expect(versioned?.content).toContain("{hjid:1234,hjsv:7}");
  });

  it("logrocket: the SDK and the guarded init, bare or with passthrough options", () => {
    const [sdk, init] = scripts(logrocket({ id: "org/app" }));
    expect(sdk).toEqual({
      attributes: { crossorigin: "anonymous", src: LOGROCKET_SCRIPT_SRC },
      content: null,
    });
    expect(init?.content).toBe(
      'window.LogRocket&&window.LogRocket.init("org/app");'
    );
    const [, configured] = scripts(logrocket({ id: "org/app", release: "1" }));
    expect(configured?.content).toBe(
      'window.LogRocket&&window.LogRocket.init("org/app",{"release":"1"});'
    );
  });

  it("mixpanel: the loader and init with the US host by default, SPA pageviews on, and the region mapped", () => {
    const [us] = scripts(mixpanel({ token: "t" }));
    expect(us?.content).toContain("window.mixpanel=b");
    expect(us?.content).toEndWith(
      `mixpanel.init("t",{"track_pageview":"url-with-path-and-query-string","api_host":"${MIXPANEL_REGION_HOSTS.us}"});`
    );
    const [eu] = scripts(mixpanel({ region: "eu", token: "t" }));
    expect(eu?.content).toContain(`"api_host":"${MIXPANEL_REGION_HOSTS.eu}"`);
    const [india] = scripts(
      mixpanel({ region: "in", token: "t", track_pageview: true })
    );
    expect(india?.content).toEndWith(
      `mixpanel.init("t",{"track_pageview":true,"api_host":"${MIXPANEL_REGION_HOSTS.in}"});`
    );
    const [raw] = scripts(
      mixpanel({ api_host: "https://mp.example.com", token: "t" })
    );
    expect(raw?.content).toContain('"api_host":"https://mp.example.com"');
  });

  it("databuddy: the async tag with data-client-id and passthrough data attributes", () => {
    expect(
      scripts(databuddy({ clientId: "abc", "track-web-vitals": "true" }))
    ).toEqual([
      {
        attributes: {
          async: true,
          crossorigin: "anonymous",
          "data-client-id": "abc",
          "data-track-web-vitals": "true",
          src: DATABUDDY_SCRIPT_SRC,
        },
        content: null,
      },
    ]);
  });

  it("pirsch: the deferred tag with its id, data-code, and passthrough data attributes", () => {
    expect(scripts(pirsch({ code: "abc", dev: "1" }))).toEqual([
      {
        attributes: {
          "data-code": "abc",
          "data-dev": "1",
          defer: true,
          id: "pianjs",
          src: PIRSCH_SCRIPT_SRC,
        },
        content: null,
      },
    ]);
  });

  it("plausible: the deferred tag from Plausible Cloud or a self-hosted origin", () => {
    expect(
      scripts(plausible({ api: "/api/event", domain: "docs.example.com" }))
    ).toEqual([
      {
        attributes: {
          "data-api": "/api/event",
          "data-domain": "docs.example.com",
          defer: true,
          src: "https://plausible.io/js/script.js",
        },
        content: null,
      },
      // The queue stub, so a `track()` before the script lands is replayed.
      { attributes: {}, content: PLAUSIBLE_QUEUE },
    ]);
    const [hosted] = scripts(
      plausible({ domain: "d", host: "https://plausible.example.com/" })
    );
    expect(hosted?.attributes.src).toBe(
      "https://plausible.example.com/js/script.js"
    );
  });

  it("segment: the snippet with the write key, SPA pageviews, and the default CDN", () => {
    const [tag] = scripts(segment({ key: "wk" }));
    expect(tag?.content).toContain('analytics._writeKey="wk";');
    expect(tag?.content).toContain(
      `t.src="${SEGMENT_DEFAULT_CDN}/analytics.js/v1/"+encodeURIComponent(key)+"/analytics.min.js"`
    );
    expect(tag?.content).not.toContain("analytics._cdn=");
    expect(tag?.content).toContain('analytics.load("wk");analytics.page();');
    expect(tag?.content).toContain("__blumeSegmentPath");
    expect(tag?.content).toContain("analytics.page();}");
  });

  it("segment: a custom CDN is used for the script and told to the library, and load options pass through", () => {
    const [tag] = scripts(
      segment({
        cdn: "https://cdn.example.com/",
        integrations: { All: false },
        key: "wk",
      })
    );
    expect(tag?.content).toContain(
      't.src="https://cdn.example.com/analytics.js/v1/"'
    );
    expect(tag?.content).toContain('analytics._cdn="https://cdn.example.com";');
    expect(tag?.content).toContain(
      'analytics.load("wk",{"integrations":{"All":false}});'
    );
  });

  it("escape < in every inline identifier so an option can't close the script", () => {
    const hostile = "</script>";
    const inline = [
      amplitude({ key: hostile }),
      clarity({ id: hostile }),
      googleAnalytics({ id: hostile }),
      googleTagManager({ id: hostile }),
      heap({ id: hostile }),
      hightouch({ key: hostile }),
      logrocket({ id: hostile }),
      mixpanel({ token: hostile }),
      segment({ key: hostile }),
    ];
    for (const adapter of inline) {
      for (const tag of scripts(adapter)) {
        expect(tag.content ?? "", adapter.kind).not.toContain("</script>");
      }
    }
  });

  it("keep a two-tag provider's tags together, in declared order", () => {
    const nodes = analyticsHead([
      plausible({ domain: "d" }),
      googleAnalytics({ id: "G-X" }),
      pirsch({ code: "c" }),
    ]);
    expect(
      nodes.map((node) =>
        node.type === "script" ? (node.attributes.src ?? "inline") : node.type
      )
    ).toEqual([
      "https://plausible.io/js/script.js",
      "inline",
      `${GOOGLE_TAG_SRC}?id=G-X`,
      "inline",
      PIRSCH_SCRIPT_SRC,
    ]);
  });
});
