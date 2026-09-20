import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { planComponentSlots } from "../src/astro/component-slots.ts";
import type { IslandSpec } from "../src/astro/islands.ts";
import {
  ACCEPTED_OVERRIDE_FORMS,
  analyzeComponentOverrides,
  emptyComponentOverrides,
} from "../src/core/component-overrides.ts";
import type {
  ComponentOverrideAnalysis,
  NormalizedOverride,
} from "../src/core/component-overrides.ts";
import { BlumeError } from "../src/core/diagnostics.ts";

const FILE = "/project/components.ts";

const analyze = (source: string) => analyzeComponentOverrides(source, FILE);

/** The diagnostic a rejected `components.ts` raises. */
const rejection = (source: string): BlumeError => {
  try {
    analyze(source);
  } catch (error) {
    if (error instanceof BlumeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected analysis to reject the file");
};

const mdxAnalysis = (
  override: Partial<NormalizedOverride>
): ComponentOverrideAnalysis => ({
  layout: [],
  mdx: [
    {
      key: "Widget",
      source: {
        framework: "react",
        name: "default",
        path: "/project/Widget.tsx",
      },
      ...override,
    },
  ],
  warnings: [],
});

const island = (over: Partial<IslandSpec> = {}): IslandSpec => ({
  client: "visible",
  file: "/project/islands/Counter.tsx",
  framework: "react",
  name: "Counter",
  ...over,
});

describe("analyzeComponentOverrides accepted forms", () => {
  it("reads an imported identifier (shorthand) as a static override", () => {
    const result = analyze(`
      import Footer from "./Footer.astro";
      export default { layout: { Footer } };
    `);
    const [footer] = result.layout;
    expect(footer?.key).toBe("Footer");
    expect(footer?.client).toBeUndefined();
    expect(footer?.source.path).toBe("/project/Footer.astro");
    expect(footer?.source.framework).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("reads an imported identifier under a different key", () => {
    const result = analyze(`
      import MyChart from "./Chart.tsx";
      export default { mdx: { Chart: MyChart } };
    `);
    const [chart] = result.mdx;
    expect(chart?.key).toBe("Chart");
    expect(chart?.source.path).toBe("/project/Chart.tsx");
    expect(result.warnings.join(" ")).toContain("no hydration mode");
  });

  it("resolves a string-path override to an absolute path", () => {
    const result = analyze(`
      export default { layout: { Footer: "./components/footer.astro" } };
    `);
    const [footer] = result.layout;
    expect(footer?.source.path).toBe("/project/components/footer.astro");
    expect(footer?.source.framework).toBeNull();
    expect(footer?.client).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("keeps a bare specifier as-is", () => {
    const result = analyze(`
      import { Widget } from "@acme/widgets";
      export default { mdx: { Widget: { component: Widget, client: "load" } } };
    `);
    const [widget] = result.mdx;
    expect(widget?.source).toEqual({
      framework: null,
      name: "Widget",
      path: "@acme/widgets",
    });
  });

  it("reads a hydrated descriptor with a path-string component", () => {
    const result = analyze(`
      export default {
        layout: { Footer: { component: "./Footer.tsx", client: "load" } },
      };
    `);
    const [footer] = result.layout;
    expect(footer?.key).toBe("Footer");
    expect(footer?.client).toBe("load");
    expect(footer?.source.path).toBe("/project/Footer.tsx");
    expect(footer?.source.framework).toBe("react");
  });

  it("reads a hydrated descriptor with a named import binding", () => {
    const result = analyze(`
      import { Fancy as Header } from "./Header.tsx";
      export default { layout: { Header: { component: Header, client: "idle" } } };
    `);
    const [header] = result.layout;
    expect(header?.source.name).toBe("Fancy");
    expect(header?.source.path).toBe("/project/Header.tsx");
    expect(header?.client).toBe("idle");
  });

  it("reads a descriptor whose `component` is a shorthand property", () => {
    const result = analyze(`
      import component from "./Widget.tsx";
      export default { mdx: { Widget: { component, client: "visible" } } };
    `);
    const [widget] = result.mdx;
    expect(widget?.source.path).toBe("/project/Widget.tsx");
    expect(widget?.client).toBe("visible");
  });

  it("reads a descriptor with a media query", () => {
    const result = analyze(`
      export default {
        mdx: { Wide: { component: "./Wide.tsx", client: "media", media: "(min-width: 40rem)" } },
      };
    `);
    expect(result.mdx[0]?.media).toBe("(min-width: 40rem)");
  });

  it("reads a non-hydrated descriptor (a static override)", () => {
    const result = analyze(`
      export default { mdx: { Note: { component: "./Note.astro" } } };
    `);
    const [note] = result.mdx;
    expect(note?.client).toBeUndefined();
    expect(note?.source.path).toBe("/project/Note.astro");
    expect(result.warnings).toEqual([]);
  });

  it("unwraps a defineComponents(...) call expression", () => {
    const result = analyze(`
      import { defineComponents } from "blume";
      import Counter from "./Counter.tsx";
      export default defineComponents({ mdx: { Counter: { component: Counter, client: "visible" } } });
    `);
    expect(result.mdx).toHaveLength(1);
    expect(result.mdx[0]?.client).toBe("visible");
  });

  it("unwraps a parenthesized `as` default export to the object", () => {
    const result = analyze(
      'export default ({ layout: { F: "./F.astro" } }) as const;'
    );
    expect(result.layout).toHaveLength(1);
    expect(result.layout[0]?.key).toBe("F");
  });

  it("accepts an empty object and an empty group", () => {
    expect(analyze("export default {};").mdx).toEqual([]);
    expect(analyze("export default { mdx: {}, layout: {} };").layout).toEqual(
      []
    );
  });

  it("infers vue and svelte frameworks from the extension", () => {
    const result = analyze(`
      export default {
        mdx: {
          V: { component: "./V.vue", client: "visible" },
          S: { component: "./S.svelte", client: "visible" },
        },
      };
    `);
    expect(result.mdx.map((entry) => entry.source.framework)).toEqual([
      "vue",
      "svelte",
    ]);
  });

  it("ignores side-effect imports with no import clause", () => {
    const result = analyze(`
      import "./register-globals.ts";
      import Counter from "./Counter.tsx";
      export default { mdx: { Counter: { component: Counter, client: "load" } } };
    `);
    expect(result.mdx[0]?.source.path).toBe("/project/Counter.tsx");
  });

  it("accepts string-literal keys", () => {
    const result = analyze(`
      export default { mdx: { "Foo.Bar": "./One.astro" } };
    `);
    expect(result.mdx[0]?.key).toBe("Foo.Bar");
  });
});

describe("analyzeComponentOverrides warnings", () => {
  it("warns when a framework component is used with no hydration mode", () => {
    const result = analyze(`
      import Chart from "./Chart.tsx";
      export default { mdx: { Chart } };
    `);
    expect(result.warnings.join(" ")).toContain("no hydration mode");
  });

  it("warns when client: media has no media query", () => {
    const result = analyze(`
      export default {
        mdx: { Custom: { component: "./Custom.tsx", client: "media" } },
      };
    `);
    expect(result.warnings.join(" ")).toContain('client: "media"');
  });

  it("warns when client: only can't infer a framework", () => {
    const result = analyze(
      'export default { mdx: { Solo: { component: "./Solo.astro", client: "only" } } };'
    );
    expect(result.warnings.join(" ")).toContain('client: "only"');
  });
});

describe("analyzeComponentOverrides rejected forms", () => {
  it("raises BLUME_COMPONENTS_INVALID pointing at the file", () => {
    const error = rejection("export default { mdx: { Widget: () => null } };");
    expect(error.diagnostic.code).toBe("BLUME_COMPONENTS_INVALID");
    expect(error.diagnostic.severity).toBe("error");
    expect(error.diagnostic.file).toBe(FILE);
    expect(error.diagnostic.message).toStartWith(
      "components.ts has 1 override(s) Blume can't plan:"
    );
    expect(error.diagnostic.suggestion).toBe(ACCEPTED_OVERRIDE_FORMS);
  });

  it("rejects a file with no default export", () => {
    expect(rejection("export const x = 1;").message).toContain(
      "No default export was found"
    );
  });

  it("rejects a default export that is not an object shape", () => {
    expect(
      rejection("const config = 42;\nexport default config;").message
    ).toContain(
      "isn't an object literal or a `defineComponents({ ... })` call"
    );
    expect(
      rejection("export default defineComponents(123);").message
    ).toContain("isn't an object literal");
  });

  it("rejects the removed `islands` group with a migration hint", () => {
    const { message } = rejection(`
      import Counter from "./Counter.tsx";
      export default { islands: { Counter } };
    `);
    expect(message).toContain("The `islands` group was folded into `mdx`");
    expect(message).toContain('client: "visible"');
  });

  it("rejects an unknown group", () => {
    expect(
      rejection('export default { theme: { Foo: "./Foo.tsx" } };').message
    ).toContain("`theme` isn't an override group; use `mdx` or `layout`");
  });

  it("rejects a group that is not an object literal", () => {
    expect(rejection("export default { mdx: 123 };").message).toContain(
      "`mdx` must be an object literal of overrides"
    );
    expect(
      rejection("const mdx = {};\nexport default { mdx };").message
    ).toContain("`mdx` must be an object literal of overrides");
  });

  it("rejects a spread among the top-level groups", () => {
    expect(
      rejection('export default { ...base, mdx: { W: "./W.tsx" } };').message
    ).toContain("The top-level object contains a spread (`...base`)");
  });

  it("rejects a spread inside a group", () => {
    expect(
      rejection("const extra = {};\nexport default { mdx: { ...extra } };")
        .message
    ).toContain("mdx contains a spread (`...extra`); list each override");
  });

  it("rejects a computed key", () => {
    expect(
      rejection(
        'const dynamic = "X";\nexport default { mdx: { [dynamic]: "./X.tsx" } };'
      ).message
    ).toContain("mdx has an entry with a computed key (`[dynamic]`)");
  });

  it("rejects a method entry", () => {
    expect(
      rejection("export default { mdx: { Widget() { return null; } } };")
        .message
    ).toContain("mdx.Widget is a method or accessor");
  });

  it("rejects an inline expression, naming the entry", () => {
    expect(
      rejection("export default { mdx: { Widget: () => null } };").message
    ).toContain("mdx.Widget is an inline expression");
    expect(
      rejection("export default { layout: { Footer: Foo.Bar } };").message
    ).toContain("layout.Footer is an inline expression");
  });

  it("rejects an identifier that is not imported", () => {
    const { message } = rejection(`
      const Local = () => null;
      export default { mdx: { Widget: Local } };
    `);
    expect(message).toContain(
      'mdx.Widget refers to "Local", which isn\'t imported in this file'
    );
    expect(rejection("export default { mdx: { Counter } };").message).toContain(
      'mdx.Counter refers to "Counter", which isn\'t imported'
    );
  });

  it("rejects a descriptor without a `component` field", () => {
    expect(
      rejection('export default { mdx: { X: { client: "load" } } };').message
    ).toContain("mdx.X is an object literal without a `component` field");
  });

  it("rejects a descriptor whose `component` is not an import or a path", () => {
    expect(
      rejection(
        'export default { mdx: { X: { component: () => null, client: "load" } } };'
      ).message
    ).toContain(
      "mdx.X's `component` must be an imported identifier or a path string"
    );
    expect(
      rejection(`
        const Local = () => null;
        export default { mdx: { X: { component: Local, client: "load" } } };
      `).message
    ).toContain(
      "mdx.X's `component` refers to \"Local\", which isn't imported"
    );
    expect(
      rejection(`
        const component = () => null;
        export default { mdx: { X: { component } } };
      `).message
    ).toContain('mdx.X\'s `component` refers to "component"');
  });

  it("rejects a `client` that is not a known mode string literal", () => {
    const expected = 'mdx.X\'s `client` must be a string literal: "load"';
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", client: "eager" } } };'
      ).message
    ).toContain(expected);
    expect(
      rejection(
        'const mode = "load";\nexport default { mdx: { X: { component: "./X.tsx", client: mode } } };'
      ).message
    ).toContain(expected);
  });

  it("rejects a `media` that is not a string literal", () => {
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", client: "media", media: query } } };'
      ).message
    ).toContain("mdx.X's `media` must be a string literal");
  });

  it("rejects unknown descriptor fields, spreads, and shorthand extras", () => {
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", props: {} } } };'
      ).message
    ).toContain("mdx.X has a `props` field; only `component`");
    expect(
      rejection(
        'export default { mdx: { X: { ...shared, component: "./X.tsx" } } };'
      ).message
    ).toContain("mdx.X contains a spread, method, or accessor");
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", client } } };'
      ).message
    ).toContain(
      "mdx.X writes `client` as a shorthand property; only `component` may be shorthand, `client` must be a string literal."
    );
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", media } } };'
      ).message
    ).toContain("mdx.X writes `media` as a shorthand property");
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", props } } };'
      ).message
    ).toContain("mdx.X has a `props` field; only `component`");
    expect(
      rejection(
        'export default { mdx: { X: { component: "./X.tsx", ["cl" + "ient"]: "load" } } };'
      ).message
    ).toContain('mdx.X has a `["cl" + "ient"]` field');
  });

  it("collects every rejection in one diagnostic", () => {
    const { message } = rejection(`
      export default {
        islands: {},
        mdx: { A: () => null, B: Missing },
      };
    `);
    expect(message).toStartWith(
      "components.ts has 3 override(s) Blume can't plan:"
    );
    expect(message).toContain("\n  - The `islands` group");
    expect(message).toContain("\n  - mdx.A is an inline expression");
    expect(message).toContain('\n  - mdx.B refers to "Missing"');
  });
});

describe("analyzeComponentOverrides with real files", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  const makeProject = async (
    files: Record<string, string>
  ): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "blume-overrides-"));
    dirs.push(dir);
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        const abs = join(dir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      })
    );
    return dir;
  };

  it("probes extensions for an extensionless relative path", async () => {
    const dir = await makeProject({
      "Widget.tsx": "export default () => null;",
    });
    const result = analyzeComponentOverrides(
      'export default { mdx: { Widget: { component: "./Widget", client: "load" } } };',
      join(dir, "components.ts")
    );
    const [widget] = result.mdx;
    expect(widget?.source.path).toBe(join(dir, "Widget.tsx"));
    expect(widget?.source.framework).toBe("react");
  });

  it("keeps an extensionless path unresolved when no file is found", async () => {
    const dir = await makeProject({ "keep.txt": "noop" });
    const result = analyzeComponentOverrides(
      'export default { mdx: { Missing: "./DoesNotExist" } };',
      join(dir, "components.ts")
    );
    const [missing] = result.mdx;
    expect(missing?.source.path).toBe(join(dir, "DoesNotExist"));
    expect(missing?.source.framework).toBeNull();
  });
});

describe("planComponentSlots", () => {
  it("returns typed empty maps with no islands and no components file", () => {
    const plan = planComponentSlots([], emptyComponentOverrides());
    expect(plan.wrappers).toEqual([]);
    expect(plan.frameworks.size).toBe(0);
    expect(plan.module).toContain(
      "export const mdxComponents: Record<string, ComponentOverride> = {};"
    );
    expect(plan.module).toContain(
      "export const layoutOverrides: Record<string, ComponentOverride> = {};"
    );
    expect(plan.module).not.toContain("__blumeSlot");
  });

  it("never spreads a runtime overrides object", () => {
    const analysis = analyze(`
      import Footer from "./Footer.astro";
      export default { layout: { Footer }, mdx: { Note: "./Note.astro" } };
    `);
    const plan = planComponentSlots([], analysis);
    expect(plan.module).not.toContain("overrides");
    expect(plan.module).not.toContain("...");
    expect(plan.module).not.toContain(FILE);
  });

  it("imports a static identifier override directly (no wrapper)", () => {
    const analysis = analyze(`
      import { Fancy as Footer } from "./Footer.astro";
      export default { layout: { Footer } };
    `);
    const plan = planComponentSlots([], analysis);
    expect(plan.wrappers).toEqual([]);
    expect(plan.module).toContain(
      'import { Fancy as __blumeSlot0 } from "/project/Footer.astro";'
    );
    expect(plan.module).toContain(
      'export const layoutOverrides: Record<string, ComponentOverride> = { "Footer": __blumeSlot0 };'
    );
  });

  it("imports a static string-path override directly (no wrapper)", () => {
    const analysis = analyze(`
      export default { layout: { Footer: "./footer.astro" } };
    `);
    const plan = planComponentSlots([], analysis);
    expect(plan.wrappers).toEqual([]);
    expect(plan.module).toContain(
      'import __blumeSlot0 from "/project/footer.astro"'
    );
    expect(plan.module).toContain('"Footer": __blumeSlot0');
  });

  it("emits a hydration wrapper for a hydrated mdx entry", () => {
    const analysis = analyze(`
      import Counter from "./Counter.tsx";
      export default { mdx: { Counter: { component: Counter, client: "visible" } } };
    `);
    const plan = planComponentSlots([], analysis);
    expect(plan.frameworks.has("react")).toBe(true);
    expect(plan.wrappers).toHaveLength(1);
    expect(plan.wrappers[0]?.name).toBe("mdx-Counter");
    expect(plan.wrappers[0]?.content).toContain(
      'import Component from "/project/Counter.tsx";'
    );
    expect(plan.wrappers[0]?.content).toContain(
      "<Component client:visible {...Astro.props}><slot /></Component>"
    );
    expect(plan.module).toContain(
      'import __blumeSlot0 from "./component-slots/mdx-Counter.astro";'
    );
    expect(plan.module).toContain('"Counter": __blumeSlot0');
  });

  it("wraps a named-export component under the Component alias", () => {
    const analysis = analyze(`
      import { Fancy } from "./Header.tsx";
      export default { layout: { Header: { component: Fancy, client: "load" } } };
    `);
    const plan = planComponentSlots([], analysis);
    expect(plan.wrappers[0]?.name).toBe("layout-Header");
    expect(plan.wrappers[0]?.content).toContain(
      'import { Fancy as Component } from "/project/Header.tsx";'
    );
  });

  // Without a `Props` alias the spread contributes nothing to the JSX props
  // type, so a component with a required prop fails `astro check` (#91).
  it("types wrapper Props from the component so required props type-check", () => {
    const plan = planComponentSlots([], mdxAnalysis({ client: "load" }));
    const content = plan.wrappers[0]?.content ?? "";
    expect(content).toContain("type Props = typeof Component extends (");
    expect(content).toContain("infer P extends object");
  });

  it("plans an islands/ convention component as a hydrated mdx entry", () => {
    const plan = planComponentSlots([island()], emptyComponentOverrides());
    expect(plan.frameworks.has("react")).toBe(true);
    expect(plan.wrappers).toHaveLength(1);
    expect(plan.wrappers[0]?.name).toBe("mdx-Counter");
    expect(plan.wrappers[0]?.content).toContain(
      'import Component from "/project/islands/Counter.tsx";'
    );
    expect(plan.wrappers[0]?.content).toContain("client:visible");
    expect(plan.module).toContain('"Counter": __blumeSlot0');
  });

  it("produces the same wrapper for a hydrated mdx entry as for an island", () => {
    const fromIsland = planComponentSlots(
      [island({ client: "load" })],
      emptyComponentOverrides()
    );
    const fromMdx = planComponentSlots(
      [],
      analyze(`
        import Counter from "./islands/Counter.tsx";
        export default { mdx: { Counter: { component: Counter, client: "load" } } };
      `)
    );
    expect(fromMdx.wrappers).toEqual(fromIsland.wrappers);
    expect(fromMdx.module).toBe(fromIsland.module);
    expect(fromMdx.frameworks).toEqual(fromIsland.frameworks);
  });

  it("applies client:only with the island's framework", () => {
    const plan = planComponentSlots(
      [island({ client: "only", file: "/p/islands/W.vue", framework: "vue" })],
      emptyComponentOverrides()
    );
    expect(plan.wrappers[0]?.content).toContain('client:only="vue"');
    expect(plan.frameworks.has("vue")).toBe(true);
  });

  it("lets a components.ts mdx entry replace a convention island of the same name", () => {
    const plan = planComponentSlots(
      [island(), island({ file: "/project/islands/Chart.tsx", name: "Chart" })],
      analyze(`
        export default { mdx: { Counter: "./Counter.astro" } };
      `)
    );
    expect(plan.wrappers.map((wrapper) => wrapper.name)).toEqual(["mdx-Chart"]);
    expect(plan.module).toContain('"Counter": __blumeSlot');
    expect(plan.module).toContain(
      'import __blumeSlot0 from "/project/Counter.astro"'
    );
    expect(plan.module).not.toContain("islands/Counter.tsx");
    expect(plan.module.match(/"Counter":/gu)).toHaveLength(1);
  });

  it("applies client:media with the query and client:only with the framework", () => {
    const analysis = analyze(`
      export default {
        mdx: {
          Wide: { component: "./Wide.tsx", client: "media", media: "(min-width: 40rem)" },
          Solo: { component: "./Solo.tsx", client: "only" },
        },
      };
    `);
    const plan = planComponentSlots([], analysis);
    const contents = plan.wrappers.map((w) => w.content).join("\n");
    expect(contents).toContain('client:media="(min-width: 40rem)"');
    expect(contents).toContain('client:only="react"');
  });

  it("emits client:idle for an idle-hydrated override", () => {
    const plan = planComponentSlots([], mdxAnalysis({ client: "idle" }));
    expect(plan.wrappers[0]?.content).toContain("client:idle");
  });

  it("falls back to client:load when client:media has no media query", () => {
    const plan = planComponentSlots([], mdxAnalysis({ client: "media" }));
    const content = plan.wrappers[0]?.content ?? "";
    expect(content).toContain("client:load");
    expect(content).not.toContain("client:media");
  });

  it("falls back to client:load for client:only without a framework", () => {
    const plan = planComponentSlots(
      [],
      mdxAnalysis({
        client: "only",
        source: {
          framework: null,
          name: "default",
          path: "/project/Solo.astro",
        },
      })
    );
    const content = plan.wrappers[0]?.content ?? "";
    expect(content).toContain("client:load");
    expect(content).not.toContain("client:only");
  });

  it("emits client:load for the default hydration mode", () => {
    const plan = planComponentSlots([], mdxAnalysis({ client: "load" }));
    expect(plan.wrappers[0]?.content).toContain("client:load");
  });

  it("scrubs quotes and newlines from a media query before interpolating", () => {
    const plan = planComponentSlots(
      [],
      mdxAnalysis({ client: "media", media: '(min-width: 40rem)"\n>' })
    );
    expect(plan.wrappers[0]?.content).toContain(
      'client:media="(min-width: 40rem)  >"'
    );
  });

  it("keeps wrapper filenames distinct for keys that sanitize alike", () => {
    // "Foo.Bar" and "Foo_Bar" used to collapse to the same wrapper file, so
    // generateRuntime raced two writes at one path and one key silently
    // rendered the other's component.
    const analysis = analyze(`
      export default {
        mdx: {
          "Foo.Bar": { component: "./One.tsx", client: "load" },
          "Foo_Bar": { component: "./Two.tsx", client: "load" },
        },
      };
    `);
    const plan = planComponentSlots([], analysis);
    const names = plan.wrappers.map((wrapper) => wrapper.name);
    expect(new Set(names).size).toBe(2);
    // "." is hex-escaped to _2e_ and "_" to _5f_, so the names stay injective.
    expect(names).toContain("mdx-Foo_2e_Bar");
    expect(names).toContain("mdx-Foo_5f_Bar");
    expect(plan.module).toContain("./component-slots/mdx-Foo_2e_Bar.astro");
    expect(plan.module).toContain("./component-slots/mdx-Foo_5f_Bar.astro");
  });
});
