import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { THEME_INIT_SCRIPT } from "../src/components/layout/head-scripts.ts";

type Listener = (event: { newDocument: FakeDocument }) => void;

interface FakeDocument {
  currentScript: { dataset: { mode?: string } } | null;
  documentElement: { dataset: { theme?: string } };
  addEventListener: (type: string, listener: Listener) => void;
  dispatch: (type: string, event: { newDocument: FakeDocument }) => void;
}

const fakeDocument = (mode?: string): FakeDocument => {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    currentScript: mode === undefined ? null : { dataset: { mode } },
    dispatch: (type, event) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    documentElement: { dataset: {} },
  };
};

let runs = 0;

// The layouts inline the script as `<script is:inline>`, so it runs against
// the real DOM globals. Stand in the handful it touches, then execute it as a
// throwaway module — a fresh file per run, since module evaluation is cached.
const runThemeScript = async (input: {
  document: FakeDocument;
  stored: string | null;
  prefersDark: boolean;
}) => {
  Object.assign(globalThis, {
    document: input.document,
    localStorage: { getItem: () => input.stored },
    matchMedia: () => ({ matches: input.prefersDark }),
  });
  const dir = await mkdtemp(path.join(tmpdir(), "blume-head-scripts-"));
  runs += 1;
  const file = path.join(dir, `theme-${runs}.js`);
  await writeFile(file, THEME_INIT_SCRIPT);
  await import(file);
};

afterEach(() => {
  for (const name of ["document", "localStorage", "matchMedia"]) {
    Reflect.deleteProperty(globalThis, name);
  }
});

describe("THEME_INIT_SCRIPT", () => {
  test("applies the stored theme before paint", async () => {
    const document = fakeDocument("light");
    await runThemeScript({ document, prefersDark: false, stored: "dark" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  test("falls back to the configured mode, then the OS setting", async () => {
    const configured = fakeDocument("dark");
    await runThemeScript({
      document: configured,
      prefersDark: false,
      stored: null,
    });
    expect(configured.documentElement.dataset.theme).toBe("dark");

    const system = fakeDocument();
    await runThemeScript({ document: system, prefersDark: true, stored: null });
    expect(system.documentElement.dataset.theme).toBe("dark");
  });

  test("carries the live theme onto the incoming document before the swap", async () => {
    // Astro's swapRootAttributes replaces <html>'s attributes with the incoming
    // document's, and its scroll restoration flushes styles before after-swap
    // fires — so the theme has to already be on the new root, or every
    // transition-colors element animates from the light palette.
    const document = fakeDocument("system");
    await runThemeScript({ document, prefersDark: true, stored: null });
    const incoming = fakeDocument();
    document.dispatch("astro:before-swap", { newDocument: incoming });
    expect(incoming.documentElement.dataset.theme).toBe("dark");
  });

  test("re-applies the theme after the swap resets the root", async () => {
    const document = fakeDocument("system");
    await runThemeScript({ document, prefersDark: false, stored: "dark" });
    Reflect.deleteProperty(document.documentElement.dataset, "theme");
    document.dispatch("astro:after-swap", { newDocument: fakeDocument() });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  test("leaves the incoming document alone when no theme is set yet", async () => {
    const document = fakeDocument("system");
    await runThemeScript({ document, prefersDark: false, stored: null });
    Reflect.deleteProperty(document.documentElement.dataset, "theme");
    const incoming = fakeDocument();
    document.dispatch("astro:before-swap", { newDocument: incoming });
    expect(incoming.documentElement.dataset.theme).toBeUndefined();
  });
});
