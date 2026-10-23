import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { ContentStringsData } from "../src/components/content/content-strings.ts";
import {
  aroundPlaceholder,
  referenceStrings,
} from "../src/components/openapi/strings.ts";
import { validateJson } from "../src/components/openapi/validate-json.ts";
import { EN_UI, resolveUIStrings } from "../src/core/i18n-ui.ts";
import type { UIStrings } from "../src/core/i18n-ui.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import type { SourceEntry } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";
import { UI_PACKS } from "../src/core/ui-packs/index.ts";
import { extractGraphqlOperations } from "../src/openapi/graphql.ts";
import { extractOperations } from "../src/openapi/model.ts";
import type { ApiDocument } from "../src/openapi/model.ts";
import { parseGraphqlSpec } from "../src/openapi/parse.ts";
import { openapi } from "../src/reference/index.ts";

/**
 * The API reference's chrome used to be hard-coded English, so a site whose
 * default locale is zh-CN showed "Overview", "Try it", and "Query parameters"
 * among Chinese chrome. It now reads the `reference` UI strings: the page's
 * locale for the components, the default locale for what the reference adds
 * to the sidebar, whose routes stay the English slugs.
 */

const zh = resolveUIStrings("zh-CN", { defaultLocale: "zh-CN" }).reference;

const PLACEHOLDER = /\{[a-z]+\}/giu;
const CODE_SPAN = /`[^`]+`/gu;
const tokens = (text: string, pattern: RegExp): string =>
  (text.match(pattern) ?? []).toSorted().join(" ");

describe("reference UI strings", () => {
  it("translates every key in every shipped pack, placeholders and code intact", () => {
    for (const [code, pack] of Object.entries(UI_PACKS)) {
      for (const [key, english] of Object.entries(EN_UI.reference)) {
        const translated = pack.reference?.[key];
        expect(
          translated,
          `pack "${code}" misses reference.${key}`
        ).toBeTruthy();
        expect(
          tokens(translated ?? "", PLACEHOLDER),
          `pack "${code}" reference.${key} placeholders`
        ).toBe(tokens(english, PLACEHOLDER));
        expect(
          tokens(translated ?? "", CODE_SPAN),
          `pack "${code}" reference.${key} code spans`
        ).toBe(tokens(english, CODE_SPAN));
      }
    }
  });
});

/** `blume:data` as the components read it. */
const dataOf = (
  ui: UIStrings,
  uiByLocale: Record<string, UIStrings> = {},
  i18n: ContentStringsData["config"]["i18n"] = null
): ContentStringsData => ({ config: { i18n }, ui, uiByLocale });

describe("referenceStrings", () => {
  it("reads the site dictionary without i18n, with the sidebar's deprecated badge", () => {
    const strings = referenceStrings(dataOf(EN_UI), "fr");
    expect(strings.tryIt).toBe("Try it");
    expect(strings.deprecated).toBe(EN_UI.nav.deprecated);
  });

  it("follows the page's locale, and the default for one it doesn't know", () => {
    const fr = resolveUIStrings("fr", { defaultLocale: "zh-CN" });
    const zhUi = resolveUIStrings("zh-CN", { defaultLocale: "zh-CN" });
    const data = dataOf(zhUi, { fr, "zh-CN": zhUi }, {});
    expect(referenceStrings(data, "fr").tryIt).toBe(fr.reference.tryIt);
    expect(referenceStrings(data, "fr").deprecated).toBe(fr.nav.deprecated);
    expect(referenceStrings(data, "ja").overview).toBe(zh.overview);
    expect(referenceStrings(data).overview).toBe(zh.overview);
  });

  it("fills a key the dictionary lacks with English, and merges once per dictionary", () => {
    const reference: Partial<UIStrings["reference"]> = { tryIt: "Essayer" };
    const partial: UIStrings = {
      ...EN_UI,
      nav: { ...EN_UI.nav, deprecated: "" },
      // SAFETY: a dictionary from an older release can lack keys; the
      // resolver's English fill is what this test checks.
      reference: reference as UIStrings["reference"],
    };
    const data = dataOf(partial);
    const strings = referenceStrings(data);
    expect(strings.tryIt).toBe("Essayer");
    expect(strings.send).toBe("Send");
    expect(strings.deprecated).toBe("deprecated");
    expect(referenceStrings(data)).toBe(strings);
  });
});

describe("aroundPlaceholder", () => {
  it("splits a label around the value it wraps in markup", () => {
    expect(aroundPlaceholder("Array of {type}", "{type}")).toStrictEqual([
      "Array of ",
      "",
    ]);
    expect(aroundPlaceholder("{name} への循環参照。", "{name}")).toStrictEqual([
      "",
      " への循環参照。",
    ]);
  });

  it("keeps a translation that dropped the placeholder in front of the value", () => {
    expect(aroundPlaceholder("Circular reference.", "{name}")).toStrictEqual([
      "Circular reference.",
      "",
    ]);
  });
});

describe("validateJson messages", () => {
  it("words each failure with the strings it's given", () => {
    const strings = {
      ...EN_UI.reference,
      notAllowed: "{values} only, at {path}",
      requiredMissing: "missing: {path}",
      wrongType: "{actual} where {expected} goes, at {path}",
    };
    expect(validateJson("[]", strings, { type: "object" })).toStrictEqual([
      "array where object goes, at body",
    ]);
    expect(
      validateJson('"x"', strings, { enum: ["a", "b"] }, "payload")
    ).toStrictEqual(['"a", "b" only, at payload']);
    expect(
      validateJson("{}", strings, { required: ["name"], type: "object" })
    ).toStrictEqual(["missing: body.name"]);
  });
});

/** A spec with a declared tag, an untagged operation, and an untagged webhook. */
const SPEC: ApiDocument = {
  info: { title: "Pets", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/health": { get: { operationId: "health", summary: "Health" } },
    "/pets": {
      get: { operationId: "listPets", summary: "List", tags: ["Pets"] },
    },
  },
  tags: [{ name: "Pets" }],
  webhooks: { petAdded: { post: { summary: "Pet added" } } },
};

/** Load the reference `resolveSources` builds for `i18n`, from a temp project. */
const loadReference = async (i18n?: BlumeConfigInput["i18n"]) => {
  const root = await mkdtemp(join(tmpdir(), "blume-reference-ui-"));
  await writeFile(join(root, "spec.json"), JSON.stringify(SPEC));
  const input: BlumeConfigInput = {
    reference: [openapi({ route: "/api", spec: "spec.json" })],
  };
  if (i18n) {
    input.i18n = i18n;
  }
  const config = blumeConfigSchema.parse(input);
  // SAFETY: resolveSources only reads `root`, `contentRoot`, and `outDir`
  // from the context; the other ProjectContext paths are never touched.
  const context = {
    contentRoot: join(root, "docs"),
    outDir: join(root, ".blume"),
    root,
  } as ProjectContext;
  const source = resolveSources(config, context, { mode: "build" }).at(-1);
  const result = await source?.load();
  await rm(root, { force: true, recursive: true });
  return result;
};

const entryAt = (entries: SourceEntry[] | undefined, ref: string) =>
  entries?.find((entry) => entry.ref === ref);

const ZH_I18N: BlumeConfigInput["i18n"] = {
  defaultLocale: "zh-CN",
  locales: [
    { code: "zh-CN", label: "简体中文" },
    { code: "en", label: "English" },
  ],
};

describe("the reference's sidebar labels", () => {
  it("come from the default locale, while the routes stay English", async () => {
    const result = await loadReference(ZH_I18N);
    expect(
      entryAt(result?.entries, "api/index.mdx")?.data.sidebar
    ).toStrictEqual({ label: zh.overview });
    // The untagged groups keep their English slugs, so no page moves.
    expect(entryAt(result?.entries, "api/operations/health.mdx")).toBeDefined();
    expect(
      entryAt(result?.entries, "api/webhooks/pet-added.mdx")
    ).toBeDefined();
    expect(result?.folderMeta?.["api/operations"]?.title).toBe(zh.operations);
    expect(result?.folderMeta?.["api/webhooks"]?.title).toBe(zh.webhooks);
    // The spec's own tag is never translated.
    expect(result?.folderMeta?.["api/pets"]?.title).toBe("Pets");
  });

  it("take the default locale's i18n.ui override", async () => {
    const result = await loadReference({
      ...ZH_I18N,
      ui: { "zh-CN": { reference: { overview: "总览" } } },
    });
    expect(
      entryAt(result?.entries, "api/index.mdx")?.data.sidebar
    ).toStrictEqual({ label: "总览" });
  });

  it("stay English without i18n", async () => {
    const result = await loadReference();
    expect(
      entryAt(result?.entries, "api/index.mdx")?.data.sidebar
    ).toStrictEqual({ label: "Overview" });
    expect(result?.folderMeta?.["api/operations"]?.title).toBe("Operations");
  });

  it("leave a tag the spec declares as Operations its own name", () => {
    const declared: ApiDocument = {
      ...SPEC,
      tags: [{ name: "Operations" }, { name: "Webhooks" }],
    };
    const { tags } = extractOperations(declared, "/api", zh);
    expect(tags.map((tag) => tag.name)).toStrictEqual([
      "Operations",
      "Webhooks",
      "Pets",
    ]);
  });

  it("word GraphQL's kind groups, keeping their slugs", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-reference-ui-"));
    await writeFile(
      join(root, "schema.graphql"),
      "type Query { pet: Pet }\ntype Pet { name: String }\n"
    );
    const { document } = await parseGraphqlSpec("schema.graphql", root);
    await rm(root, { force: true, recursive: true });
    const { operations, tags } = extractGraphqlOperations(
      document,
      "/graphql",
      zh
    );
    expect(tags.map((tag) => [tag.slug, tag.name])).toStrictEqual([
      ["queries", zh.graphqlQueries],
      ["objects", zh.graphqlObjects],
    ]);
    expect(operations.map((operation) => operation.route)).toStrictEqual([
      "/graphql/queries/pet",
      "/graphql/objects/pet",
    ]);
  });
});
