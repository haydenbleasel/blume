import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";

import { createSearch } from "../src/components/layout/search/pagefind.ts";

/**
 * The Pagefind client against a stand-in `pagefind.js`. Like the real bundle,
 * the stand-in's `createInstance` reads the page's `<html lang>` as it
 * creates an instance, and each instance records the language it read, the
 * options it was given, the indexes merged into it, and the queries it
 * searched. `fetch` serves the bundle's `pagefind-entry.json`.
 */

/** What the stand-in records for each instance it creates. */
interface CreatedInstance {
  language: string;
  merged: { url: string; options: { baseUrl: string; language: string } }[];
  options: { basePath: string; baseUrl: string };
  searches: string[];
}

/** The page the client reads its language and base URI from. */
const page = { lang: "en" };
const documentDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "document"
);
const originalFetch = globalThis.fetch;

/** The `pagefind-entry.json` served, and the URLs fetched. */
let entry = "";
const fetched: string[] = [];

/** An entry file listing an index per language, with its page count. */
const entryFile = (pageCounts: Record<string, number>): string =>
  JSON.stringify({
    languages: Object.fromEntries(
      Object.entries(pageCounts).map(([code, pages]) => [
        code,
        { page_count: pages },
      ])
    ),
    version: "1.5.2",
  });

beforeAll(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: "https://example.com/docs/guide", documentElement: page },
    writable: true,
  });
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0]) => {
      fetched.push(String(input));
      return Promise.resolve(new Response(entry));
    },
    { preconnect: originalFetch.preconnect }
  );
});

afterEach(() => {
  fetched.length = 0;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  // SAFETY: views globalThis as carrying just the document faked above, so
  // `delete` can remove it where no original descriptor existed.
  const globals = globalThis as { document?: unknown };
  if (documentDescriptor) {
    Object.defineProperty(globalThis, "document", documentDescriptor);
  } else {
    delete globals.document;
  }
});

/** Write a stand-in bundle; each test gets its own module instance. */
const bundle = async (): Promise<{
  created: CreatedInstance[];
  url: string;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-pagefind-client-"));
  const file = join(dir, "pagefind.mjs");
  await writeFile(
    file,
    [
      "export const created = [];",
      "const result = (url, title) => ({ data: () => Promise.resolve({ excerpt: 'pf', meta: title ? { title } : undefined, url }) });",
      "export const createInstance = (options) => {",
      "  const instance = { language: globalThis.document.documentElement.lang, merged: [], options, searches: [] };",
      "  created.push(instance);",
      "  return {",
      "    mergeIndex: (url, options) => { instance.merged.push({ options, url }); return Promise.resolve(); },",
      "    search: (query) => { instance.searches.push(query); return Promise.resolve({ results: [result('/p/', 'PF'), result('/'), result('/q/#part', 'Q')] }); },",
      "  };",
      "};",
    ].join("\n")
  );
  const url = pathToFileURL(file).href;
  // SAFETY: the stand-in written above exports `created` as this list.
  const { created } = (await import(url)) as { created: CreatedInstance[] };
  return { created, url };
};

/** The languages merged into each instance the stand-in created. */
const mergedLanguages = (created: CreatedInstance[]) =>
  created.map(({ language, merged }) => ({
    language,
    merged: merged.map(({ options }) => options.language),
  }));

/** The languages merged into a search created for a page in `lang`. */
const merged = async (lang: string) => {
  page.lang = lang;
  const { created, url } = await bundle();
  await (
    await createSearch({ url })
  )("q");
  return mergedLanguages(created);
};

describe("Pagefind search client", () => {
  it("maps results to the dialog's slashless, base-less routes", async () => {
    page.lang = "en";
    const { created, url } = await bundle();
    const search = await createSearch({ url });
    const { hits } = await search("q", { locale: "en" });
    // Base-less routes, as every provider returns them: the dialog mounts the
    // deployment base itself.
    expect(created.map((instance) => instance.options.baseUrl)).toStrictEqual([
      "/",
    ]);
    // Slashless, as Blume serves pages; the home route and a fragment keep
    // their shape.
    expect(hits.map((hit) => hit.url)).toStrictEqual(["/p", "/", "/q#part"]);
    expect(hits[0]?.title).toBe("PF");
    expect(hits[1]?.title).toBe("/");
  });

  it("searches the index of the page's current language", async () => {
    page.lang = "en";
    const { created, url } = await bundle();
    const search = await createSearch({ url });
    await search("one", { locale: "en" });
    await search("two", { locale: "en" });
    // A client-side language switch: same client, new page language.
    page.lang = "ja";
    await search("three", { locale: "ja" });
    page.lang = "en";
    await search("four", { locale: "en" });
    expect(
      created.map(({ language, searches }) => ({ language, searches }))
    ).toStrictEqual([
      { language: "en", searches: ["one", "two", "four"] },
      { language: "ja", searches: ["three"] },
    ]);
    // A scoped search merges nothing and never reads the entry file.
    expect(mergedLanguages(created)).toStrictEqual([
      { language: "en", merged: [] },
      { language: "ja", merged: [] },
    ]);
    expect(fetched).toStrictEqual([]);
  });

  it("merges every other language's index into an unscoped search", async () => {
    entry = entryFile({ en: 3, ja: 2, "pt-br": 1 });
    page.lang = "pt-BR";
    const { created, url } = await bundle();
    const search = await createSearch({ url });
    await search("one");
    // One every-language instance for the page load, whatever page it's on.
    page.lang = "ja";
    await search("two");
    expect(fetched).toHaveLength(1);
    const folder = url.slice(0, url.lastIndexOf("/") + 1);
    expect(fetched[0]).toBe(`${folder}pagefind-entry.json`);
    expect(created).toHaveLength(1);
    expect(created[0]?.options.basePath).toBe(new URL(folder).pathname);
    expect(created[0]?.searches).toStrictEqual(["one", "two"]);
    // The page's own index is the instance's; the others are merged in by the
    // bundle's full URL, which Pagefind doesn't take for its own path.
    expect(created[0]?.merged).toStrictEqual([
      { options: { baseUrl: "/", language: "en" }, url: folder },
      { options: { baseUrl: "/", language: "ja" }, url: folder },
    ]);
  });

  it("leaves out the index Pagefind loads for a page with none of its own", async () => {
    entry = entryFile({ en: 3, ja: 5, pt: 1 });
    // Pagefind falls back to the base language, then to the largest index.
    expect(await merged("pt-BR")).toStrictEqual([
      { language: "pt-BR", merged: ["en", "ja"] },
    ]);
    expect(await merged("fr")).toStrictEqual([
      { language: "fr", merged: ["en", "pt"] },
    ]);
    // A page with no language reads as Pagefind's "unknown".
    expect(await merged("")).toStrictEqual([
      { language: "", merged: ["en", "pt"] },
    ]);
  });

  it("retries the every-language index after a failed load", async () => {
    entry = entryFile({ en: 1 });
    page.lang = "en";
    const { created, url } = await bundle();
    const search = await createSearch({ url });
    const working = globalThis.fetch;
    globalThis.fetch = Object.assign(
      () => Promise.reject(new Error("offline")),
      { preconnect: originalFetch.preconnect }
    );
    try {
      await expect(search("q")).rejects.toThrow("offline");
    } finally {
      globalThis.fetch = working;
    }
    const { hits } = await search("q");
    expect(hits).toHaveLength(3);
    expect(created).toHaveLength(2);
  });
});
