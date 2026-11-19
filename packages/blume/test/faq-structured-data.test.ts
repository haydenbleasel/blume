import { describe, expect, it } from "bun:test";

import { mdxToJs } from "satteri";
import type { MdastPluginDefinition } from "satteri";

import { catchAllPageTemplate } from "../src/astro/templates.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import { FAQ_KEY, faqPlugin } from "../src/markdown/faq.ts";
import type { FaqEntry } from "../src/markdown/faq.ts";
import type { MdastValue } from "../src/markdown/mdast.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import type { JsonLdNode, StructuredDataInput } from "../src/seo/jsonld.ts";

// SAFETY: the plugin models the slice of Satteri's visitor protocol it
// uses, as Blume's pipeline bridges it (see `asMdastPlugin` there).
const asMdastPlugin = (plugin: { name: string }): MdastPluginDefinition =>
  plugin as MdastPluginDefinition;

/** The render frontmatter the plugin leaves for `source` under `frontmatter`. */
const faqOf = async (
  source: string,
  frontmatter?: Record<string, MdastValue>
): Promise<FaqEntry[] | undefined> => {
  const data: Record<string, { frontmatter: Record<string, MdastValue> }> =
    frontmatter ? { astro: { frontmatter } } : {};
  await mdxToJs(source, { data, mdastPlugins: [asMdastPlugin(faqPlugin())] });
  // SAFETY: the plugin writes FaqEntry objects under FAQ_KEY.
  return data.astro?.frontmatter[FAQ_KEY] as FaqEntry[] | undefined;
};

const PAGE = [
  "Intro text.",
  "",
  "## What is Acme?",
  "",
  "Acme is a **linter** preset. Run `acme init`.",
  "",
  "- Fast",
  "- Strict",
  "",
  "```sh",
  "acme check",
  "```",
  "",
  "### A detail",
  "",
  "Still the same answer.",
  "",
  // A node with no text and no children adds nothing.
  "***",
  "",
  "## Setup",
  "",
  "Not a question, so not an entry.",
  "",
  "## Is it free?",
  "",
  "## Does it [lint CSS](/docs/css)?",
  "",
  "<Callout>With Stylelint, yes.</Callout>",
].join("\n");

describe("faqPlugin", () => {
  it("lists each question heading with the text up to the next h2", async () => {
    expect(await faqOf(PAGE, { seo: { faq: true } })).toEqual([
      {
        answer:
          "Acme is a linter preset. Run acme init. Fast Strict A detail Still the same answer.",
        question: "What is Acme?",
      },
      // "Is it free?" has no answer before the next question, so it's dropped.
      { answer: "With Stylelint, yes.", question: "Does it lint CSS?" },
    ]);
  });

  it("does nothing unless the page turns its FAQ on", async () => {
    expect(await faqOf(PAGE, { seo: { faq: false } })).toBeUndefined();
    expect(await faqOf(PAGE, { seo: "faq" })).toBeUndefined();
    expect(await faqOf(PAGE, {})).toBeUndefined();
    expect(await faqOf(PAGE)).toBeUndefined();
    // On, but nothing to list.
    expect(
      await faqOf("## Setup\n\nText.\n", { seo: { faq: true } })
    ).toBeUndefined();
  });

  it("is a page-level front matter option", () => {
    expect(pageMetaSchema.parse({ seo: { faq: true } }).seo.faq).toBe(true);
    expect(pageMetaSchema.parse({}).seo.faq).toBeUndefined();
  });

  it("reaches the layout from the page template", () => {
    const template = catchAllPageTemplate({
      exportEpub: false,
      exportPdf: false,
      mathEnabled: false,
      needsReact: false,
    });
    expect(template).toContain(`remarkPluginFrontmatter?.${FAQ_KEY}`);
    expect(template).toContain("faq={faq}");
  });
});

const input = (over: Partial<StructuredDataInput>): StructuredDataInput => ({
  breadcrumbs: [],
  route: "/guide",
  siteName: "Acme",
  siteUrl: "https://acme.dev",
  title: "Guide",
  ...over,
});

/** The graph's node of a `@type`. */
const nodeOf = (graph: JsonLdNode, type: string): JsonLdNode | undefined => {
  const nodes = graph["@graph"];
  // SAFETY: buildStructuredData always returns an `@graph` array of nodes.
  return (nodes as JsonLdNode[]).find((node) => node["@type"] === type);
};

describe("buildStructuredData", () => {
  it("adds a FAQPage node for the page's questions", () => {
    const graph = buildStructuredData(
      input({ faq: [{ answer: "A preset.", question: "What is Acme?" }] })
    );
    expect(nodeOf(graph, "FAQPage")).toEqual({
      "@id": "https://acme.dev/guide#faq",
      "@type": "FAQPage",
      inLanguage: "en",
      isPartOf: { "@id": "https://acme.dev/guide#page" },
      mainEntity: [
        {
          "@type": "Question",
          acceptedAnswer: { "@type": "Answer", text: "A preset." },
          name: "What is Acme?",
        },
      ],
      url: "https://acme.dev/guide",
    });
    expect(nodeOf(buildStructuredData(input({ faq: [] })), "FAQPage")).toBe(
      undefined
    );
  });

  it("types the page node as asked", () => {
    const graph = buildStructuredData(input({ schemaType: "CollectionPage" }));
    expect(nodeOf(graph, "CollectionPage")?.headline).toBe("Guide");
    expect(nodeOf(graph, "TechArticle")).toBeUndefined();
  });

  it("describes the software's version, requirements, and where to get it", () => {
    const graph = buildStructuredData(
      input({
        identity: {
          software: {
            applicationCategory: "DeveloperApplication",
            downloadUrl: "https://www.npmjs.com/package/acme",
            installUrl: "https://acme.dev/docs/setup",
            priceCurrency: "USD",
            sameAs: [],
            softwareRequirements: "Node.js 22+",
            softwareVersion: "8.3.0",
          },
        },
        route: "/",
      })
    );
    expect(nodeOf(graph, "SoftwareApplication")).toMatchObject({
      downloadUrl: "https://www.npmjs.com/package/acme",
      installUrl: "https://acme.dev/docs/setup",
      softwareRequirements: "Node.js 22+",
      softwareVersion: "8.3.0",
    });
    expect(
      blumeConfigSchema.parse({
        seo: {
          software: {
            downloadUrl: "https://www.npmjs.com/package/acme",
            softwareVersion: "8.3.0",
          },
        },
      }).seo.software
    ).toMatchObject({ softwareVersion: "8.3.0" });
  });
});
