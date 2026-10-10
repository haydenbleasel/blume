import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildRuntimeData } from "../src/astro/generate.ts";
import type { BlumeData } from "../src/core/data.ts";
import { gitPublishedTime } from "../src/core/last-modified.ts";
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
const git = (root: string, args: string[], date?: string): string => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        ![
          "GIT_DIR",
          "GIT_WORK_TREE",
          "GIT_INDEX_FILE",
          "GIT_COMMON_DIR",
          "GIT_OBJECT_DIRECTORY",
          "GIT_PREFIX",
        ].includes(key)
    )
  );
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  // oxlint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
};
const commit = (root: string, date: string): void => {
  git(root, ["add", "-A"]);
  git(
    root,
    [
      "-c",
      "user.name=Blume Test",
      "-c",
      "user.email=test@blume.dev",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    date
  );
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});
describe("SEO entity options", () => {
  it("preserves defaults and validates opt-in configuration", () => {
    const { seo } = blumeConfigSchema.parse({});
    expect(seo.jsonLd).toEqual({ website: true });
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
  });
  it("reuses IDs on emitted nodes and references", () => {
    const graph = graphOf({
      ...base,
      identity: {
        organization: { contactType: "customer support", sameAs: [] },
      },
      jsonLd: {
        organizationId: "https://example.com/#company",
        websiteId: "https://example.com/#site",
      },
    });
    expect(graph.WebSite?.["@id"]).toBe("https://example.com/#site");
    expect(graph.Organization?.["@id"]).toBe("https://example.com/#company");
    expect(graph.WebSite?.publisher).toEqual({
      "@id": "https://example.com/#company",
    });
    expect(graph.TechArticle?.publisher).toEqual({
      "@id": "https://example.com/#company",
    });
    expect(graph.TechArticle?.isPartOf).toEqual({
      "@id": "https://example.com/#site",
    });
  });
  it("suppresses the WebSite definition and references external entities", () => {
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
});
describe("Git publication dates", () => {
  it("uses the first commit across edits and renames and serializes opt-in runtime data", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { seo: { datePublished: "git", og: { image: { en: "/default.png" } }, jsonLd: { website: false } } };',
      "docs/old.md": "# Guide\n",
    });
    git(root, ["init"]);
    commit(root, "2020-01-02T00:00:00Z");
    git(root, ["mv", "docs/old.md", "docs/guide.md"]);
    commit(root, "2021-01-02T00:00:00Z");
    await writeFile(
      join(root, "docs/guide.md"),
      "---\ndate: 2030-01-01\n---\n# Guide\n\nEdited.\n"
    );
    commit(root, "2022-01-02T00:00:00Z");
    expect(gitPublishedTime(root, join(root, "docs/guide.md"))).toBe(
      "2020-01-02T00:00:00.000Z"
    );
    expect(gitPublishedTime(root, "docs/untracked.md")).toBeUndefined();
    expect(gitPublishedTime(root)).toBeUndefined();
    const project = await scanProject(root);
    const data: BlumeData = JSON.parse(buildRuntimeData(project));
    expect(data.routes[0]?.published).toBe("2020-01-02T00:00:00.000Z");
    expect(data.config.og.image).toEqual({ en: "/default.png" });
    expect(data.config.jsonLd.website).toBe(false);
    expect(data.config.datePublished).toBe("git");
    project.config.seo.datePublished = false;
    project.config.seo.og.image = "/default.png";
    const defaults: BlumeData = JSON.parse(buildRuntimeData(project));
    expect(defaults.routes[0]?.published).toBeNull();
    expect(defaults.config.og.image).toBe("/default.png");
    const shallow = join(await fixture({}), "clone");
    git(dirname(shallow), ["clone", "--depth", "1", `file://${root}`, shallow]);
    expect(gitPublishedTime(shallow, "docs/guide.md")).toBeUndefined();
  });
  it("omits dates outside a repository or for an invalid pathspec", async () => {
    const root = await fixture({});
    expect(gitPublishedTime(root, "missing.md")).toBeUndefined();
    git(root, ["init"]);
    expect(gitPublishedTime(root, "/outside/repository.md")).toBeUndefined();
  });
});
describe("sitemap locale alternates", () => {
  it("includes self, default locale and deployment base while excluding noindex pages", async () => {
    const root = await fixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://example.com", base: "/sub" }, i18n: { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }, { code: "de", label: "German" }], fallbackLocale: null }, seo: { sitemap: { alternates: true } } };',
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
});
