import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SCALAR_THEME_INIT_SCRIPT,
  THEME_INIT_SCRIPT,
} from "../src/components/layout/head-scripts.ts";

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

interface ClassList {
  classes: Set<string>;
  toggle: (name: string, force: boolean) => void;
}

interface ScalarContainer {
  dataset: { configuration?: string };
}

interface ScalarDocument {
  documentElement: { dataset: { theme?: string } };
  body: { classList: ClassList };
  querySelectorAll: (selector: string) => ScalarContainer[];
}

type ThemeRoot = ScalarDocument["documentElement"];

interface Observation {
  target: ThemeRoot;
  options: { attributes: boolean; attributeFilter: string[] };
  fire: () => void;
}

const classList = (initial: string[]): ClassList => {
  const classes = new Set(initial);
  return {
    classes,
    toggle: (name, force) => {
      if (force) {
        classes.add(name);
      } else {
        classes.delete(name);
      }
    },
  };
};

const scalarDocument = (input: {
  theme: string;
  containers: ScalarContainer[];
}): ScalarDocument => ({
  body: { classList: classList(["light-mode"]) },
  documentElement: { dataset: { theme: input.theme } },
  querySelectorAll: (selector) =>
    selector === "[data-scalar-client]" ? input.containers : [],
});

// Same throwaway-module trick as the theme script, with a MutationObserver
// stand-in that records what it was asked to watch and lets a test fire it.
const runScalarThemeScript = async (
  document: ScalarDocument
): Promise<Observation[]> => {
  const observations: Observation[] = [];
  class FakeMutationObserver {
    private readonly handler: () => void;
    constructor(handler: () => void) {
      this.handler = handler;
    }
    observe(
      target: ThemeRoot,
      options: { attributes: boolean; attributeFilter: string[] }
    ) {
      observations.push({ fire: () => this.handler(), options, target });
    }
  }
  Object.assign(globalThis, {
    MutationObserver: FakeMutationObserver,
    document,
  });
  const dir = await mkdtemp(path.join(tmpdir(), "blume-head-scripts-"));
  runs += 1;
  const file = path.join(dir, `scalar-theme-${runs}.js`);
  await writeFile(file, SCALAR_THEME_INIT_SCRIPT);
  await import(file);
  Reflect.deleteProperty(globalThis, "MutationObserver");
  return observations;
};

describe("SCALAR_THEME_INIT_SCRIPT", () => {
  test("pins Scalar's color mode to the page theme before it mounts", async () => {
    const container: ScalarContainer = {
      dataset: { configuration: '{"content":"openapi: 3.1.0"}' },
    };
    const document = scalarDocument({ containers: [container], theme: "dark" });
    const observations = await runScalarThemeScript(document);
    expect(JSON.parse(container.dataset.configuration ?? "")).toEqual({
      content: "openapi: 3.1.0",
      forceDarkModeState: "dark",
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.target).toBe(document.documentElement);
    expect(observations[0]?.options).toEqual({
      attributeFilter: ["data-theme"],
      attributes: true,
    });
  });

  test("mirrors later toggles onto Scalar's body classes", async () => {
    const container: ScalarContainer = { dataset: { configuration: "{}" } };
    const document = scalarDocument({
      containers: [container],
      theme: "light",
    });
    const [observation] = await runScalarThemeScript(document);
    expect(JSON.parse(container.dataset.configuration ?? "")).toEqual({
      forceDarkModeState: "light",
    });

    document.documentElement.dataset.theme = "dark";
    observation?.fire();
    expect([...document.body.classList.classes]).toEqual(["dark-mode"]);

    document.documentElement.dataset.theme = "light";
    observation?.fire();
    expect([...document.body.classList.classes]).toEqual(["light-mode"]);
  });

  test("treats a missing configuration as empty and an unset theme as light", async () => {
    const container: ScalarContainer = { dataset: {} };
    const document = scalarDocument({ containers: [container], theme: "" });
    Reflect.deleteProperty(document.documentElement.dataset, "theme");
    await runScalarThemeScript(document);
    expect(JSON.parse(container.dataset.configuration ?? "")).toEqual({
      forceDarkModeState: "light",
    });
  });

  test("leaves a container the author already pinned to Scalar", async () => {
    // `scalar` escape-hatch options win over Blume's derived config, so an
    // explicit color mode keeps Scalar's own toggle and persistence.
    const forced: ScalarContainer = {
      dataset: { configuration: '{"forceDarkModeState":"dark"}' },
    };
    const initial: ScalarContainer = {
      dataset: { configuration: '{"darkMode":true}' },
    };
    const broken: ScalarContainer = { dataset: { configuration: "{nope" } };
    const document = scalarDocument({
      containers: [forced, initial, broken],
      theme: "light",
    });
    const observations = await runScalarThemeScript(document);
    expect(forced.dataset.configuration).toBe('{"forceDarkModeState":"dark"}');
    expect(initial.dataset.configuration).toBe('{"darkMode":true}');
    expect(broken.dataset.configuration).toBe("{nope");
    expect(observations).toHaveLength(0);
  });
});
