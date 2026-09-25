import { describe, expect, it } from "bun:test";

import {
  examplesPageTemplate,
  notFoundPageTemplate,
} from "../src/astro/templates.ts";
import { mountBase } from "../src/components/islands/base-path.ts";
import { mountBasePath } from "../src/core/base-path.ts";

// The inline scripts generated pages ship, run against a hand-built scope:
// `with (scope)` resolves the page globals they read (`document`, `location`,
// `localStorage`, …) from the fixture, so a getter can throw the way blocked
// storage does in a real browser.

const INLINE_SCRIPT = /<script is:inline>\n(?<body>[\s\S]*?)<\/script>/gu;

/** The bodies of a template's `<script is:inline>` blocks, in order. */
const inlineScripts = (template: string): string[] =>
  [...template.matchAll(INLINE_SCRIPT)].map(
    (match) => match.groups?.body ?? ""
  );

/** Evaluate `body` with the names it reads resolved from `scope`. */
const evaluate = <Scope>(body: string, scope: Scope): string =>
  // oxlint-disable-next-line no-new-func -- the code under test is a string
  String(new Function("scope", `with (scope) {\n${body}\n}`)(scope));

/** Run `script` with the page globals it reads resolved from `scope`. */
const run = <Scope>(script: string, scope: Scope): void => {
  evaluate(script, scope);
};

/** `scope` with a `localStorage` that throws on access, as blocked storage does. */
const blockStorage = <Scope>(scope: Scope): Scope =>
  Object.defineProperty(scope, "localStorage", {
    get: () => {
      throw new Error("SecurityError: storage is blocked");
    },
  });

/** An element: attributes and text, all the 404 script touches. */
interface FakeNode {
  attrs: Map<string, string>;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  textContent: string;
}

const fakeNode = (attrs: Record<string, string> = {}): FakeNode => {
  const map = new Map(Object.entries(attrs));
  return {
    attrs: map,
    getAttribute: (name) => map.get(name) ?? null,
    setAttribute: (name, value) => {
      map.set(name, value);
    },
    textContent: "",
  };
};

/**
 * The 404 page's build-time `data-base` and a locale's home link, evaluated
 * from the template's own frontmatter lines with `withMountedBase` bound to
 * `deployBase` (it is `mountBase` over Astro's `BASE_URL`).
 */
const notFoundBases = (
  template: string,
  { basePath, deployBase }: { basePath: string; deployBase: string }
) => {
  const lines = template.split("\n");
  const line = (start: string): string =>
    lines.find((candidate) => candidate.trimStart().startsWith(start)) ?? "";
  const homeExpression = line("homeHref: ")
    .trim()
    .slice("homeHref: ".length, -1);
  const scope = {
    basePath,
    l: { code: "ja" },
    mountBasePath,
    withMountedBase: (route: string) => mountBase(deployBase, route),
  };
  return {
    dataBase: evaluate(
      `${line("const siteRoot = ")}\n${line("const localeBase = ")}\nreturn localeBase;`,
      scope
    ),
    homeHref: evaluate(`return ${homeExpression};`, scope),
  };
};

/** Run the 404 page's script at `pathname` under the given bases. */
const renderNotFoundAt = (
  pathname: string,
  {
    basePath = "",
    deployBase = "",
  }: { basePath?: string; deployBase?: string } = {}
) => {
  const template = notFoundPageTemplate();
  const [script = ""] = inlineScripts(template);
  const { dataBase, homeHref } = notFoundBases(template, {
    basePath,
    deployBase,
  });
  const home = fakeNode();
  const nav = fakeNode();
  const title = fakeNode({ "data-nf": "title" });
  const root = {
    ...fakeNode({ "data-base": dataBase }),
    querySelector: (selector: string): FakeNode =>
      selector === "[data-nf-home]" ? home : nav,
    querySelectorAll: (): FakeNode[] => [title],
  };
  const locales = fakeNode();
  locales.textContent = JSON.stringify({
    ja: {
      dir: "ltr",
      homeHref,
      suggestions: "候補",
      title: "見つかりません",
    },
  });
  const document = {
    addEventListener: () => {},
    getElementById: () => locales,
    querySelector: () => root,
    title: "Not found",
  };
  run(script, { document, location: { pathname } });
  return { dataBase, document, home, root, title };
};

describe("localized 404 page", () => {
  it("strips the deployment base, trailing slash included", () => {
    const page = renderNotFoundAt("/docs/ja/missing", { deployBase: "/docs" });
    expect(page.dataBase).toBe("/docs/");
    expect(page.root.getAttribute("lang")).toBe("ja");
    expect(page.title.textContent).toBe("見つかりません");
    expect(page.document.title).toBe("見つかりません");
    expect(page.home.getAttribute("href")).toBe("/docs/ja");
  });

  it("strips basePath instead of reading it as the locale", () => {
    const page = renderNotFoundAt("/guide/ja/missing", { basePath: "/guide" });
    expect(page.dataBase).toBe("/guide/");
    expect(page.root.getAttribute("lang")).toBe("ja");
    // The locale's home sits under basePath too.
    expect(page.home.getAttribute("href")).toBe("/guide/ja");
  });

  it("strips both bases together", () => {
    const page = renderNotFoundAt("/sub/guide/ja/missing", {
      basePath: "/guide",
      deployBase: "/sub",
    });
    expect(page.dataBase).toBe("/sub/guide/");
    expect(page.root.getAttribute("lang")).toBe("ja");
    expect(page.home.getAttribute("href")).toBe("/sub/guide/ja");
  });

  it("localizes at the root and leaves an unknown segment alone", () => {
    const rooted = renderNotFoundAt("/ja/missing");
    expect(rooted.dataBase).toBe("/");
    expect(rooted.root.getAttribute("lang")).toBe("ja");
    expect(rooted.home.getAttribute("href")).toBe("/ja");
    const miss = renderNotFoundAt("/docs/missing", { deployBase: "/docs" });
    expect(miss.root.getAttribute("lang")).toBeNull();
    expect(miss.document.title).toBe("Not found");
  });

  it("hands the script the combined base", () => {
    expect(notFoundPageTemplate()).toContain("data-base={localeBase}");
  });
});

/** The frame's document root: `data-theme` plus the `dark` class. */
interface FrameRoot {
  classList: { toggle: (name: string, on: boolean) => void };
  classes: Set<string>;
  dataset: FrameDataset;
}

interface FrameDataset {
  theme?: string;
}

const frameRoot = (): FrameRoot => {
  const classes = new Set<string>();
  const dataset: FrameDataset = {};
  return {
    classList: {
      toggle: (name, on) => {
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
    classes,
    dataset,
  };
};

/** A frame opened directly: its own parent, with no `data-theme` on it. */
interface DirectWindow {
  document: { documentElement: FrameRoot };
  parent: DirectWindow | null;
}

const directFrame = () => {
  const root = frameRoot();
  const window: DirectWindow = {
    document: { documentElement: root },
    parent: null,
  };
  window.parent = window;
  return { document: window.document, root, window };
};

/** A MutationObserver stand-in recording what it was asked to observe. */
const observerRecording = (observed: FrameRoot[]) =>
  function FakeObserver() {
    return {
      observe: (target: FrameRoot) => {
        observed.push(target);
      },
    };
  };

describe("example preview theme script", () => {
  const [script = ""] = inlineScripts(examplesPageTemplate());

  it("falls back to the OS setting when storage is blocked, opened directly", () => {
    const observed: FrameRoot[] = [];
    const { document, root, window } = directFrame();
    run(
      script,
      blockStorage({
        MutationObserver: observerRecording(observed),
        document,
        matchMedia: () => ({ matches: true }),
        window,
      })
    );
    expect(root.dataset.theme).toBe("dark");
    expect(root.classes.has("dark")).toBe(true);
    // The live-toggle observer is still wired up.
    expect(observed).toEqual([root]);
  });

  it("falls back to the OS setting when the parent and storage are both unreachable", () => {
    const root = frameRoot();
    run(
      script,
      blockStorage({
        MutationObserver: observerRecording([]),
        document: { documentElement: root },
        matchMedia: () => ({ matches: false }),
        window: {
          get parent(): never {
            throw new Error("SecurityError: cross-origin parent");
          },
        },
      })
    );
    expect(root.dataset.theme).toBe("light");
    expect(root.classes.has("dark")).toBe(false);
  });

  it("prefers the stored theme when storage is readable", () => {
    const { document, root, window } = directFrame();
    run(script, {
      MutationObserver: observerRecording([]),
      document,
      localStorage: { getItem: () => "dark" },
      matchMedia: () => ({ matches: false }),
      window,
    });
    expect(root.dataset.theme).toBe("dark");
  });
});
