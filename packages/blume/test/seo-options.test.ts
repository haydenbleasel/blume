import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildRuntimeData } from "../src/astro/generate.ts";
import { loadConfig } from "../src/core/config.ts";
import type { BlumeData } from "../src/core/data.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { buildSitemapFiles } from "../src/deploy/sitemap.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import type { JsonLdNode, StructuredDataInput } from "../src/seo/jsonld.ts";

const base: StructuredDataInput = {
  breadcrumbs: [],
  route: "/guide",
  siteName: "Docs",
  siteUrl: "https://example.com",
  title: "Guide",
};
const graphOf = (input: StructuredDataInput): Record<string, JsonLdNode> => {
  // SAFETY: buildStructuredData emits an array of graph nodes.
  const graph = buildStructuredData(input)["@graph"] as JsonLdNode[];
  return Object.fromEntries(graph.map((node) => [String(node["@type"]), node]));
};
const dirs: string[] = [];
const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-seo-options-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    })
  );
  return root;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});
/** `seo.og.enabled` as loadConfig resolves it for a site with this `og` config. */
const ogEnabled = async (og: string): Promise<boolean | undefined> => {
  const root = await fixture({
    "blume.config.ts": `export default { deployment: { site: "https://example.com" }, seo: { og: ${og} } };`,
  });
  const { config } = await loadConfig(root);
  return config.seo.og.enabled;
};
describe("SEO entity options", () => {
  it("preserves defaults and validates opt-in configuration", () => {
    const { seo } = blumeConfigSchema.parse({});
    expect(seo.jsonLd).toEqual({});
    expect(seo.datePublished).toBe(false);
    expect(seo.sitemap).toBe(true);
    expect(seo.og.image).toBeUndefined();
    expect(
      blumeConfigSchema.parse({ seo: { sitemap: {} } }).seo.sitemap
    ).toEqual({ alternates: false });
    for (const jsonLd of [
      { websiteId: "relative" },
      { organizationId: "/org" },
      { author: { "@id": "author" } },
      { publisher: { "@id": "publisher" } },
    ]) {
      expect(blumeConfigSchema.safeParse({ seo: { jsonLd } }).success).toBe(
        false
      );
    }
    expect(
      blumeConfigSchema.safeParse({ seo: { datePublished: "frontmatter" } })
        .success
    ).toBe(false);
    // A locale map needs at least one image.
    expect(
      blumeConfigSchema.safeParse({ seo: { og: { image: {} } } }).success
    ).toBe(false);
  });
  it("turns generated cards off by default beside a default image", async () => {
    expect(await ogEnabled("{}")).toBe(true);
    expect(await ogEnabled('{ image: "/og.png" }')).toBe(false);
    // An explicit setting still wins.
    expect(await ogEnabled('{ enabled: true, image: "/og.png" }')).toBe(true);
  });
  it("defines shared IDs only when asked to", () => {
    const graph = graphOf({
      ...base,
      identity: {
        organization: { contactType: "customer support", sameAs: [] },
      },
      jsonLd: {
        organizationId: "https://example.com/#company",
        website: true,
        websiteId: "https://example.com/#site",
      },
    });
    expect(graph.WebSite?.["@id"]).toBe("https://example.com/#site");
    expect(graph.WebSite?.publisher).toEqual({
      "@id": "https://example.com/#company",
    });
    // The organization is defined elsewhere, so the docs' own title and root
    // don't stand in for its name and URL.
    expect(graph.Organization).toEqual({
      "@id": "https://example.com/#company",
      "@type": "Organization",
    });
    expect(graph.TechArticle?.publisher).toEqual({
      "@id": "https://example.com/#company",
    });
    expect(graph.TechArticle?.isPartOf).toEqual({
      "@id": "https://example.com/#site",
    });
    // Configured details still go in under the shared id.
    expect(
      graphOf({
        ...base,
        identity: {
          organization: {
            contactType: "customer support",
            name: "Example",
            sameAs: [],
            url: "https://example.com",
          },
        },
        jsonLd: { organizationId: "https://example.com/#company" },
      }).Organization
    ).toMatchObject({ name: "Example", url: "https://example.com" });
  });
  it("references a shared WebSite without redefining it", () => {
    const websiteId = "https://example.com/#site";
    const graph = graphOf({ ...base, jsonLd: { websiteId } });
    expect(graph.WebSite).toBeUndefined();
    expect(graph.TechArticle?.isPartOf).toEqual({ "@id": websiteId });
    // The id is absolute, so it holds without a site URL too.
    expect(
      graphOf({ ...base, jsonLd: { websiteId }, siteUrl: null }).TechArticle
        ?.isPartOf
    ).toEqual({ "@id": websiteId });
    expect(graphOf({ ...base, siteUrl: null }).TechArticle?.isPartOf).toBe(
      undefined
    );
    // Without a shared id the docs keep their own WebSite.
    expect(graphOf(base).WebSite?.["@id"]).toBe("https://example.com#website");
  });
  it("references external entities and the page image", () => {
    const author = { "@id": "https://example.com/#author" };
    const publisher = { "@id": "https://example.com/#publisher" };
    const graph = graphOf({
      ...base,
      image: "https://example.com/og.png",
      jsonLd: {
        author,
        organizationId: "https://example.com/#company",
        publisher,
        website: false,
        websiteId: "https://example.com/#site",
      },
    });
    expect(graph.WebSite).toBeUndefined();
    expect(graph.Organization).toBeUndefined();
    expect(graph.TechArticle?.isPartOf).toEqual({
      "@id": "https://example.com/#site",
    });
    expect(graph.TechArticle?.author).toEqual(author);
    expect(graph.TechArticle?.publisher).toEqual(publisher);
    expect(graph.TechArticle?.image).toBe("https://example.com/og.png");
    expect(
      graphOf({
        ...base,
        jsonLd: { organizationId: author["@id"] },
        route: "/",
      }).WebPage?.publisher
    ).toEqual(author);
    expect(graphOf(base).TechArticle?.image).toBeUndefined();
  });
  it("credits a page's own authors over the site-wide author", () => {
    const author = { "@id": "https://example.com/#organization" };
    const post = graphOf({
      ...base,
      authors: [{ name: "Jane", url: "https://jane.dev" }, "Sam"],
      jsonLd: { author },
      pageType: "blog",
    });
    expect(post.BlogPosting?.author).toEqual([
      { "@type": "Person", name: "Jane", url: "https://jane.dev" },
      { "@type": "Person", name: "Sam" },
    ]);
    expect(
      graphOf({ ...base, authors: { name: "Jane" } }).TechArticle?.author
    ).toEqual([{ "@type": "Person", name: "Jane" }]);
    // An empty byline falls back to the site-wide author.
    expect(
      graphOf({ ...base, authors: [], jsonLd: { author } }).TechArticle?.author
    ).toEqual(author);
    expect(graphOf(base).TechArticle?.author).toBeUndefined();
  });
});
describe("SEO runtime data", () => {
  it("serializes the default image, entities and publication dates", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { seo: { og: { image: { en: "/default.png" } }, jsonLd: { website: false } } };',
      "docs/index.md": "# Guide\n",
    });
    const project = await scanProject(root);
    const [route] = project.manifest.routes;
    expect(route?.published).toBeUndefined();
    const defaults: BlumeData = JSON.parse(buildRuntimeData(project));
    expect(defaults.routes[0]?.published).toBeNull();
    expect(defaults.config.og.image).toEqual({ en: "/default.png" });
    expect(defaults.config.jsonLd.website).toBe(false);
    if (route) {
      route.published = "2020-01-02T00:00:00.000Z";
    }
    const dated: BlumeData = JSON.parse(buildRuntimeData(project));
    expect(dated.routes[0]?.published).toBe("2020-01-02T00:00:00.000Z");
  });
});
const i18nConfig = (extra: string): string =>
  `export default { deployment: { site: "https://example.com", base: "/sub" }, i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }, { code: "de", label: "German" }], fallbackLocale: null }${extra} };`;
describe("locale alternates", () => {
  it("includes self, default locale and deployment base while excluding noindex pages", async () => {
    const root = await fixture({
      "blume.config.ts": i18nConfig(", seo: { sitemap: { alternates: true } }"),
      "docs/de/index.md": "---\nseo:\n  noindex: true\n---\n# Home\n",
      "docs/fr/index.md": "# Accueil\n",
      "docs/index.md": "# Home\n",
    });
    const project = await scanProject(root);
    const xml = buildSitemapFiles(project)?.[0]?.xml ?? "";
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('hreflang="en" href="https://example.com/sub"');
    expect(xml).toContain('hreflang="fr" href="https://example.com/sub/fr"');
    expect(xml).toContain(
      'hreflang="x-default" href="https://example.com/sub"'
    );
    expect(xml).not.toContain('hreflang="de"');
    project.config.seo.sitemap = true;
    expect(buildSitemapFiles(project)?.[0]?.xml).not.toContain("xhtml");
    project.config.seo.sitemap = { alternates: true };
    for (const page of project.graph.pages) {
      page.meta.seo.noindex = page.locale === "en";
    }
    const withoutDefault = buildSitemapFiles(project)?.[0]?.xml ?? "";
    expect(withoutDefault).toContain('hreflang="de"');
    expect(withoutDefault).not.toContain('hreflang="en"');
    expect(withoutDefault).not.toContain('hreflang="x-default"');
    project.graph.pages = project.graph.pages.filter(
      (page) => page.locale === "fr"
    );
    expect(buildSitemapFiles(project)?.[0]?.xml).not.toContain("xhtml:link");
  });

  it("gives the page head the same set as the sitemap", async () => {
    const root = await fixture({
      "blume.config.ts": i18nConfig(""),
      "docs/de/index.md": "---\nseo:\n  noindex: true\n---\n# Home\n",
      "docs/fr/index.md": "# Accueil\n",
      "docs/index.md": "# Home\n",
    });
    const data: BlumeData = JSON.parse(
      buildRuntimeData(await scanProject(root))
    );
    const hreflang = Object.fromEntries(
      data.routes.map((route) => [
        route.path,
        route.hreflang.map((alternate) => alternate.locale).toSorted(),
      ])
    );
    // The noindexed German page is in no set, its own included; the switcher
    // still reaches it.
    expect(hreflang).toEqual({
      "/": ["en", "fr"],
      "/de": [],
      "/fr": ["en", "fr"],
    });
    expect(
      data.routes
        .find((route) => route.path === "/")
        ?.alternates.map((alternate) => alternate.locale)
        .toSorted()
    ).toEqual(["de", "en", "fr"]);
  });

  it("keeps an archived version's group though the sitemap leaves it out", async () => {
    const root = await fixture({
      "blume.config.ts": i18nConfig(
        ', versions: { archived: [{ id: "v1" }], current: { label: "v2" } }, seo: { sitemap: { alternates: true } }'
      ),
      "docs/fr/index.md": "# Accueil\n",
      "docs/index.md": "# Home\n",
      "docs/v1/fr/index.md": "# Accueil v1\n",
      "docs/v1/index.md": "# Home v1\n",
    });
    const project = await scanProject(root);
    const data: BlumeData = JSON.parse(buildRuntimeData(project));
    // Its canonical names the latest page, so the sitemap skips it, but the
    // version's own translations still group per version.
    expect(
      data.routes
        .find((route) => route.path === "/v1")
        ?.hreflang.map((alternate) => alternate.path)
        .toSorted()
    ).toEqual(["/fr/v1", "/v1"]);
    expect(buildSitemapFiles(project)?.[0]?.xml).not.toContain("/v1");
  });

  it("links a fallback copy to the translations it stands in for", async () => {
    const root = await fixture({
      "blume.config.ts": i18nConfig("").replace(
        "fallbackLocale: null",
        'fallbackLocale: "en"'
      ),
      "docs/fr/index.md": "# Accueil\n",
      "docs/index.md": "# Home\n",
    });
    const data: BlumeData = JSON.parse(
      buildRuntimeData(await scanProject(root))
    );
    const fallback = data.routes.find((route) => route.path === "/de");
    expect(fallback?.fallback).toBe(true);
    expect(
      fallback?.hreflang.map((alternate) => alternate.locale).toSorted()
    ).toEqual(["en", "fr"]);
  });
});
