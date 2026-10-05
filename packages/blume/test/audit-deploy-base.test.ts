import { describe, expect, it } from "bun:test";

import { assetChecks } from "../src/audit/checks/assets.ts";
import { linkChecks } from "../src/audit/checks/links.ts";
import { ogImageChecks } from "../src/audit/checks/og-image.ts";
import type { AuditContext, CheckModule } from "../src/audit/types.ts";
import { resolveHref } from "../src/audit/url.ts";
import type { Diagnostic } from "../src/core/types.ts";
import { codes, context, snapshot } from "./audit-support.ts";

/**
 * A site deployed under `deployment.base` is served entirely beneath it, so
 * a root-relative href that forgets the base points at nothing on the host —
 * even though the base-less file tree the audit reads has a page there.
 */

const SITE = "https://x.dev";
const BASE = "/base";

const findings = async (
  module: CheckModule,
  ctx: AuditContext
): Promise<Diagnostic[]> => await module.run(ctx);

const link = (href: string, content = true) => ({
  content,
  href,
  rel: null,
  text: "x",
});

describe("resolveHref under a deployment base", () => {
  it("reports a root-relative path without the base as outside it", () => {
    expect(resolveHref("/a", "/guide", SITE, BASE)).toEqual({
      absolute: false,
      kind: "outside-base",
      path: "/guide",
    });
    expect(resolveHref("/a", `${SITE}/guide/`, SITE, BASE)).toEqual({
      absolute: true,
      kind: "outside-base",
      path: "/guide",
    });
  });

  it("strips the base from paths under it", () => {
    expect(resolveHref("/a", "/base/guide#x", SITE, BASE)).toEqual({
      hash: "x",
      kind: "internal",
      path: "/guide",
    });
    expect(resolveHref("/a", "/base", SITE, BASE)).toEqual({
      hash: "",
      kind: "internal",
      path: "/",
    });
    expect(resolveHref("/a", `${SITE}/base/guide`, SITE, BASE)).toEqual({
      hash: "",
      kind: "self-origin",
      path: "/guide",
    });
  });

  it("leaves relative hrefs and base-less sites alone", () => {
    // A relative href inherits the page's base, whatever the page's URL.
    expect(resolveHref("/docs/a", "./b", SITE, BASE)).toEqual({
      hash: "",
      kind: "internal",
      path: "/docs/b",
    });
    expect(resolveHref("/a", "/guide", SITE, "")).toEqual({
      hash: "",
      kind: "internal",
      path: "/guide",
    });
  });
});

const pages = (href: string, content: boolean) => [
  snapshot({ links: [link(href, content)], url: "/a" }),
  snapshot({ url: "/guide" }),
];

describe("link checks under a deployment base", () => {
  it("reports a body link that forgot the base", async () => {
    const [finding] = await findings(
      linkChecks,
      context({ base: BASE, pages: pages("/guide", true), site: SITE })
    );
    expect(finding?.code).toBe("BLUME_AUDIT_LINK_TO_BROKEN");
    expect(finding?.message).toContain("missing deployment.base (/base)");
  });

  it("reports a navigation link that forgot the base once", async () => {
    const found = await findings(
      linkChecks,
      context({
        base: BASE,
        pages: [
          ...pages("/guide", false),
          snapshot({ links: [link("/guide", false)], url: "/b" }),
        ],
        site: SITE,
      })
    );
    const broken = found.filter(
      (finding) => finding.code === "BLUME_AUDIT_LINK_TO_BROKEN"
    );
    expect(broken.map((finding) => finding.message)).toEqual([
      "Navigation links to /guide, which the build does not serve.",
    ]);
  });

  it("leaves a full URL to another app on the same host alone", async () => {
    // The host serves the docs under the base and another app beside them;
    // a full URL is how a page links there (`/signup` on the product).
    for (const content of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop -- two tiny sequential cases
      const found = await findings(
        linkChecks,
        context({
          base: BASE,
          pages: pages(`${SITE}/signup`, content),
          site: SITE,
        })
      );
      expect(codes(found)).not.toContain("LINK_TO_BROKEN");
    }
  });

  it("is silent when the link carries the base", async () => {
    const found = await findings(
      linkChecks,
      context({ base: BASE, pages: pages("/base/guide", true), site: SITE })
    );
    expect(codes(found)).not.toContain("LINK_TO_BROKEN");
  });
});

describe("asset checks under a deployment base", () => {
  const files = new Map([
    ["/app.js", 100],
    ["/logo.png", 100],
  ]);

  it("reports images and scripts that forgot the base", async () => {
    const found = await findings(
      assetChecks,
      context({
        base: BASE,
        files,
        pages: [
          snapshot({
            images: [{ alt: "", height: "1", src: "/logo.png", width: "1" }],
            scripts: [{ src: "/app.js" }],
          }),
        ],
        site: SITE,
      })
    );
    expect(codes(found)).toEqual(["IMAGE_BROKEN", "SUBRESOURCE_MISSING"]);
    expect(found[0]?.message).toContain("missing deployment.base (/base)");
  });

  it("is silent when they carry the base", async () => {
    const found = await findings(
      assetChecks,
      context({
        base: BASE,
        files,
        pages: [
          snapshot({
            images: [
              { alt: "", height: "1", src: "/base/logo.png", width: "1" },
            ],
            scripts: [{ src: "/base/app.js" }],
          }),
        ],
        site: SITE,
      })
    );
    expect(codes(found)).toEqual([]);
  });
});

describe("Vercel image optimization URLs", () => {
  it("are served by the platform, not the build", async () => {
    // `imageService` on the Vercel adapter points <img> at the platform's
    // optimizer, which lives at the host root whatever the base.
    const image = {
      alt: "",
      height: "1",
      src: "/_vercel/image?url=%2Flogo.png&w=640&q=75",
      width: "1",
    };
    for (const base of ["", BASE]) {
      // oxlint-disable-next-line no-await-in-loop -- two tiny sequential cases
      const found = await findings(
        assetChecks,
        context({ base, pages: [snapshot({ images: [image] })], site: SITE })
      );
      expect(codes(found)).toEqual([]);
    }
  });
});

describe("og:image under a deployment base", () => {
  it("reports an og:image that forgot the base", async () => {
    const found = await findings(
      ogImageChecks,
      context({
        base: BASE,
        files: new Map([["/og.png", 100]]),
        pages: [
          snapshot({
            og: {
              "og:description": "d",
              "og:image": `${SITE}/og.png`,
              "og:title": "t",
              "og:type": "website",
              "og:url": `${SITE}/base`,
            },
          }),
        ],
        site: SITE,
      })
    );
    expect(codes(found)).toEqual(["OG_IMAGE_BROKEN"]);
    expect(found[0]?.message).toContain("missing deployment.base (/base)");
  });
});
