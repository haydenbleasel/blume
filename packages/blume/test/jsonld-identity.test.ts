import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import type { JsonLdNode, StructuredDataInput } from "../src/seo/jsonld.ts";

const base: StructuredDataInput = {
  breadcrumbs: [],
  description: "Docs for Acme.",
  route: "/",
  siteName: "Acme",
  siteUrl: "https://acme.dev/",
  title: "Acme",
};

/** The `@graph` nodes of a page's JSON-LD, keyed by `@type`. */
const graphOf = (input: StructuredDataInput): Record<string, JsonLdNode> => {
  const data = buildStructuredData(input);
  // SAFETY: buildStructuredData always returns a `@graph` array of nodes (or
  // null, which yields an empty graph here).
  const graph = (data?.["@graph"] ?? []) as JsonLdNode[];
  return Object.fromEntries(graph.map((node) => [String(node["@type"]), node]));
};

describe("buildStructuredData — organization identity", () => {
  const organization = {
    address: { addressCountry: "AU", addressLocality: "Sydney" },
    contactType: "customer support",
    email: "hello@acme.dev",
    logo: "/logo.svg",
    sameAs: ["https://github.com/acme", "https://x.com/acme"],
  };

  it("emits an Organization node the WebSite cites as publisher", () => {
    const graph = graphOf({ ...base, identity: { organization } });
    expect(graph.Organization).toStrictEqual({
      "@id": "https://acme.dev#organization",
      "@type": "Organization",
      address: {
        "@type": "PostalAddress",
        addressCountry: "AU",
        addressLocality: "Sydney",
      },
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: "hello@acme.dev",
      },
      email: "hello@acme.dev",
      logo: "https://acme.dev/logo.svg",
      name: "Acme",
      sameAs: ["https://github.com/acme", "https://x.com/acme"],
      url: "https://acme.dev",
    });
    expect(graph.WebSite?.publisher).toStrictEqual({
      "@id": "https://acme.dev#organization",
    });
  });

  it("uses explicit name/url/telephone and keeps an absolute logo verbatim", () => {
    const graph = graphOf({
      ...base,
      identity: {
        organization: {
          contactType: "sales",
          logo: "https://cdn.acme.dev/logo.png",
          name: "Acme Inc.",
          sameAs: [],
          telephone: "+61 2 0000 0000",
          url: "https://acme.com",
        },
      },
    });
    expect(graph.Organization).toStrictEqual({
      "@id": "https://acme.dev#organization",
      "@type": "Organization",
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "sales",
        telephone: "+61 2 0000 0000",
      },
      logo: "https://cdn.acme.dev/logo.png",
      name: "Acme Inc.",
      telephone: "+61 2 0000 0000",
      url: "https://acme.com",
    });
  });

  it("omits the contact point, address, and sameAs when there is nothing to say", () => {
    const graph = graphOf({
      ...base,
      identity: {
        organization: { address: {}, contactType: "support", sameAs: [] },
      },
    });
    expect(graph.Organization).toStrictEqual({
      "@id": "https://acme.dev#organization",
      "@type": "Organization",
      name: "Acme",
      url: "https://acme.dev",
    });
  });

  it("bases a root-relative logo under deployment.base", () => {
    const graph = graphOf({
      ...base,
      base: "/docs",
      identity: {
        organization: { contactType: "support", logo: "/logo.svg", sameAs: [] },
      },
    });
    expect(graph.Organization?.logo).toBe("https://acme.dev/docs/logo.svg");
    expect(graph.Organization?.url).toBe("https://acme.dev/docs");
  });

  it("cites the organization as publisher on article pages too", () => {
    const graph = graphOf({
      ...base,
      identity: { organization: { contactType: "support", sameAs: [] } },
      route: "/guide",
      title: "Guide",
    });
    expect(graph.TechArticle?.publisher).toStrictEqual({
      "@id": "https://acme.dev#organization",
    });
    expect(graph.Organization).toBeDefined();
  });

  it("needs a site — identity nodes have absolute ids", () => {
    const data = buildStructuredData({
      ...base,
      identity: { organization: { contactType: "support", sameAs: [] } },
      siteUrl: null,
    });
    expect(data).toBeNull();
    const graph = graphOf({
      ...base,
      identity: { organization: { contactType: "support", sameAs: [] } },
      route: "/guide",
      siteUrl: null,
    });
    expect(graph.Organization).toBeUndefined();
    expect(graph.TechArticle?.publisher).toBeUndefined();
  });
});

describe("buildStructuredData — software identity", () => {
  const software = {
    applicationCategory: "DeveloperApplication",
    license: "MIT",
    operatingSystem: "Node.js 22+",
    price: 0,
    priceCurrency: "USD",
    sameAs: ["https://www.npmjs.com/package/acme"],
  };

  it("emits a SoftwareApplication node on the homepage, published by the organization", () => {
    const graph = graphOf({
      ...base,
      identity: {
        organization: { contactType: "support", sameAs: [] },
        software,
      },
    });
    expect(graph.SoftwareApplication).toStrictEqual({
      "@id": "https://acme.dev#software",
      "@type": "SoftwareApplication",
      applicationCategory: "DeveloperApplication",
      description: "Docs for Acme.",
      license: "MIT",
      name: "Acme",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      operatingSystem: "Node.js 22+",
      publisher: { "@id": "https://acme.dev#organization" },
      sameAs: ["https://www.npmjs.com/package/acme"],
      url: "https://acme.dev",
    });
  });

  it("takes explicit name and description, and stays minimal without extras", () => {
    const graph = graphOf({
      ...base,
      description: undefined,
      identity: {
        software: {
          applicationCategory: "BusinessApplication",
          description: "Flags as a service.",
          name: "Acme Flags",
          priceCurrency: "EUR",
          sameAs: [],
        },
      },
    });
    expect(graph.SoftwareApplication).toStrictEqual({
      "@id": "https://acme.dev#software",
      "@type": "SoftwareApplication",
      applicationCategory: "BusinessApplication",
      description: "Flags as a service.",
      name: "Acme Flags",
      url: "https://acme.dev",
    });
  });

  it("has no description when neither the product nor the site has one", () => {
    const graph = graphOf({
      ...base,
      description: undefined,
      identity: {
        software: {
          applicationCategory: "DeveloperApplication",
          priceCurrency: "USD",
          sameAs: [],
        },
      },
    });
    expect(graph.SoftwareApplication?.description).toBeUndefined();
  });

  it("stays off deeper pages", () => {
    const graph = graphOf({
      ...base,
      identity: { software },
      route: "/guide",
      title: "Guide",
    });
    expect(graph.SoftwareApplication).toBeUndefined();
    expect(graph.TechArticle).toBeDefined();
  });

  it("is skipped without a site, like the WebSite node", () => {
    expect(
      buildStructuredData({ ...base, identity: { software }, siteUrl: null })
    ).toBeNull();
  });
});

describe("seo.organization / seo.software schema", () => {
  it("applies the organization defaults and validates URLs", () => {
    const { seo } = blumeConfigSchema.parse({
      seo: {
        organization: {
          email: "hello@acme.dev",
          sameAs: ["https://x.com/acme"],
        },
      },
    });
    expect(seo.organization).toStrictEqual({
      contactType: "customer support",
      email: "hello@acme.dev",
      sameAs: ["https://x.com/acme"],
    });
    expect(() =>
      blumeConfigSchema.parse({ seo: { organization: { sameAs: ["acme"] } } })
    ).toThrow();
    expect(() =>
      blumeConfigSchema.parse({ seo: { organization: { email: "nope" } } })
    ).toThrow();
  });

  it("resolves software: true to the defaults, false to nothing, and keeps the object form", () => {
    expect(blumeConfigSchema.parse({}).seo.software).toBeUndefined();
    expect(
      blumeConfigSchema.parse({ seo: { software: false } }).seo.software
    ).toBeUndefined();
    expect(
      blumeConfigSchema.parse({ seo: { software: true } }).seo.software
    ).toStrictEqual({
      applicationCategory: "DeveloperApplication",
      priceCurrency: "USD",
      sameAs: [],
    });
    expect(
      blumeConfigSchema.parse({
        seo: { software: { license: "MIT", price: "0" } },
      }).seo.software
    ).toStrictEqual({
      applicationCategory: "DeveloperApplication",
      license: "MIT",
      price: "0",
      priceCurrency: "USD",
      sameAs: [],
    });
    expect(() =>
      blumeConfigSchema.parse({ seo: { software: { price: -1 } } })
    ).toThrow();
  });
});
