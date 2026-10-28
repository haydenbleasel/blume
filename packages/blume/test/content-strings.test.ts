import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { contentStrings } from "../src/components/content/content-strings.ts";
import { stableId, tooltipId } from "../src/components/content/tooltip-id.ts";
import { EN_UI } from "../src/core/i18n-ui.ts";
import type { UIStrings } from "../src/core/i18n-ui.ts";
import { UI_PACKS } from "../src/core/ui-packs/index.ts";

const french: UIStrings = {
  ...EN_UI,
  actions: { ...EN_UI.actions, copied: "Copié !" },
  content: { ...EN_UI.content, copyPrompt: "Copier le prompt" },
};

describe("contentStrings", () => {
  it("resolves the labels of the locale Astro routed the page to", () => {
    const strings = contentStrings(
      { config: { i18n: {} }, ui: EN_UI, uiByLocale: { fr: french } },
      "fr"
    );
    expect(strings.content.copyPrompt).toBe("Copier le prompt");
    expect(strings.actions.copied).toBe("Copié !");
    // A key the translation lacks still renders, from the English baseline.
    expect(strings.content.copyColor).toBe("Copy {name} color {value}");
  });

  it("falls back to the site default for an unknown locale, no locale, or no i18n", () => {
    const data = { config: { i18n: {} }, ui: french, uiByLocale: {} };
    expect(contentStrings(data, "de").content.copyPrompt).toBe(
      "Copier le prompt"
    );
    expect(contentStrings(data).actions.copied).toBe("Copié !");
    expect(
      contentStrings(
        { config: { i18n: null }, ui: EN_UI, uiByLocale: { fr: french } },
        "fr"
      ).content.copyPrompt
    ).toBe("Copy prompt");
  });

  it("merges over the English baseline so a partial dictionary stays whole", () => {
    // SAFETY: a stale snapshot can carry a dictionary missing whole keys; the
    // assertion models that runtime shape.
    const partial = { actions: {}, content: {} } as UIStrings;
    const strings = contentStrings({
      config: { i18n: null },
      ui: partial,
      uiByLocale: {},
    });
    expect(strings.content.copyPrompt).toBe("Copy prompt");
    expect(strings.actions.openIn).toBe("Open in {name}");
  });

  it("localizes the Prompt and Color labels in every shipped pack", () => {
    for (const [code, pack] of Object.entries(UI_PACKS)) {
      expect(
        pack.content?.copyPrompt,
        `pack "${code}" misses content.copyPrompt`
      ).toBeTruthy();
      const copyColor = pack.content?.copyColor ?? "";
      expect(copyColor, `pack "${code}" copyColor misses {name}`).toContain(
        "{name}"
      );
      expect(copyColor, `pack "${code}" copyColor misses {value}`).toContain(
        "{value}"
      );
    }
  });
});

describe("stableId", () => {
  it("prefixes the digest and keeps prefixes apart on one page", () => {
    const locals = {};
    const body = stableId(locals, "blume-body-errors", ["petstore", "getPet"]);
    expect(body).toMatch(/^blume-body-errors-[0-9a-f]{12}$/u);
    expect(
      stableId(locals, "blume-payload-errors", ["petstore", "getPet"])
    ).toMatch(/^blume-payload-errors-[0-9a-f]{12}$/u);
    expect(stableId(locals, "blume-body-errors", ["petstore", "getPet"])).toBe(
      `${body}-2`
    );
  });
});

describe("tooltipId", () => {
  it("derives the id from the content, so a rebuild reproduces it", () => {
    const content = ["label", "Headline", "Tip", undefined, undefined];
    const first = tooltipId({}, content);
    expect(first).toMatch(/^blume-tooltip-[0-9a-f]{12}$/u);
    expect(tooltipId({}, content)).toBe(first);
    expect(tooltipId({}, ["other"])).not.toBe(first);
  });

  it("numbers repeats of an identical tooltip within one page render", () => {
    const locals = {};
    const content = ["same"];
    const first = tooltipId(locals, content);
    expect(tooltipId(locals, content)).toBe(`${first}-2`);
    expect(tooltipId(locals, content)).toBe(`${first}-3`);
    // Another page render starts its own count.
    expect(tooltipId({}, content)).toBe(first);
  });
});

describe("content component history writes", () => {
  it("keeps the client router's history state when a tab or accordion updates the URL", async () => {
    // Astro's router ignores a popstate whose state is null, so replacing the
    // entry with `null` made Back after opening a tab or accordion change the
    // URL without changing the page.
    const files = ["Tabs.astro", "AccordionItem.astro"];
    const sources = await Promise.all(
      files.map((file) =>
        readFile(
          new URL(`../src/components/content/${file}`, import.meta.url),
          "utf-8"
        )
      )
    );
    for (const [index, source] of sources.entries()) {
      const file = files[index];
      expect(source, file).toContain("history.state");
      expect(source, file).not.toMatch(/replaceState\(\s*null/u);
      expect(source, file).not.toMatch(/pushState\(\s*null/u);
    }
  });
});

describe("Mermaid element module", () => {
  it("stays a module, so astro check accepts its lazy import", async () => {
    // `blume:features` loads it with `import()`; a file with no import or
    // export is a script, which `astro check` rejects with ts(2306) on every
    // site that has a diagram.
    const source = await readFile(
      new URL("../src/components/content/mermaid-element.ts", import.meta.url),
      "utf-8"
    );
    expect(source).toMatch(/^export /mu);
  });

  it("imports Pele dynamically, so a page without a diagram never loads it", async () => {
    // `blume:features` imports this module on every page of a site that has a
    // diagram. A static value import of `pele` here would put the renderer in
    // every page's module graph; only the type import and the dynamic import
    // are allowed.
    const source = await readFile(
      new URL("../src/components/content/mermaid-element.ts", import.meta.url),
      "utf-8"
    );
    expect(source).toContain('import type { Mounted } from "pele";');
    expect(source).not.toMatch(/^import (?!type\b)/mu);
    expect(source).toContain('import("pele")');
  });
});
