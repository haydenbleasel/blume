import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { planComponentSlots } from "../src/astro/component-slots.ts";
import { analyzeComponentOverrides } from "../src/core/component-overrides.ts";
import type {
  ComponentOverrideAnalysis,
  NormalizedOverride,
} from "../src/core/component-overrides.ts";

const FILE = "/project/components.ts";

const analyze = (source: string) => analyzeComponentOverrides(source, FILE);

const mdxAnalysis = (
  override: Partial<NormalizedOverride>
): ComponentOverrideAnalysis => ({
  islands: [],
  layout: [],
  mdx: [
    {
      identifier: false,
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

describe("analyzeComponentOverrides", () => {
  it("returns empty groups when there is no default export object", () => {
    const result = analyze("export const x = 1;");
    expect(result.mdx).toEqual([]);
    expect(result.layout).toEqual([]);
    expect(result.islands).toEqual([]);
  });

  it("reads an islands-group shorthand as a hydrated framework component", () => {
    const result = analyze(`
      import Counter from "./islands/Counter.tsx";
      export default { islands: { Counter } };
    `);
    expect(result.islands).toHaveLength(1);
    const [island] = result.islands;
    expect(island?.key).toBe("Counter");
    expect(island?.client).toBe("visible");
    expect(island?.source?.path).toBe("/project/islands/Counter.tsx");
    expect(island?.source?.framework).toBe("react");
    expect(result.warnings).toEqual([]);
  });

  it("unwraps a defineComponents(...) call expression", () => {
    const result = analyze(`
      import { defineComponents } from "blume";
      import Counter from "./Counter.tsx";
      export default defineComponents({ islands: { Counter } });
    `);
    expect(result.islands).toHaveLength(1);
  });

  it("reads a hydrated layout descriptor with a client mode", () => {
    const result = analyze(`
      export default {
        layout: { Footer: { component: "./Footer.tsx", client: "load" } },
      };
    `);
    const [footer] = result.layout;
    expect(footer?.key).toBe("Footer");
    expect(footer?.client).toBe("load");
    expect(footer?.identifier).toBe(false);
    expect(footer?.source?.path).toBe("/project/Footer.tsx");
  });

  it("resolves a string-path override to an absolute path", () => {
    const result = analyze(`
      export default { layout: { Footer: "./components/footer.astro" } };
    `);
    const [footer] = result.layout;
    expect(footer?.source?.path).toBe("/project/components/footer.astro");
    expect(footer?.source?.framework).toBeNull();
    expect(footer?.client).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("resolves a named import binding for a descriptor component", () => {
    const result = analyze(`
      import { Fancy as Header } from "./Header.tsx";
      export default { layout: { Header: { component: Header, client: "idle" } } };
    `);
    const [header] = result.layout;
    expect(header?.source?.name).toBe("Fancy");
    expect(header?.source?.path).toBe("/project/Header.tsx");
    expect(header?.client).toBe("idle");
  });

  it("keeps a bare .astro identifier on the runtime object with no warning", () => {
    const result = analyze(`
      import Footer from "./Footer.astro";
      export default { layout: { Footer } };
    `);
    const [footer] = result.layout;
    expect(footer?.identifier).toBe(true);
    expect(footer?.source?.framework).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("warns when a framework component is used with no hydration mode", () => {
    const result = analyze(`
      import Chart from "./Chart.tsx";
      export default { mdx: { Chart } };
    `);
    expect(result.mdx[0]?.identifier).toBe(true);
    expect(result.warnings.join(" ")).toContain("no hydration mode");
  });

  it("warns and drops an island that is not a framework component", () => {
    const result = analyze(`
      export default { islands: { Thing: "./Thing.astro" } };
    `);
    expect(result.islands).toEqual([]);
    expect(result.warnings.join(" ")).toContain("not a React, Vue, or Svelte");
  });

  it("warns when client is set but the component can't be resolved", () => {
    const result = analyze(`
      const Local = () => null;
      export default { mdx: { Widget: { component: Local, client: "load" } } };
    `);
    expect(result.warnings.join(" ")).toContain("couldn't be resolved");
  });

  it("warns when client: media has no media query", () => {
    const result = analyze(`
      export default {
        mdx: { Custom: { component: "./Custom.tsx", client: "media" } },
      };
    `);
    expect(result.warnings.join(" ")).toContain('client: "media"');
  });

  it("infers vue and svelte frameworks from the extension", () => {
    const result = analyze(`
      export default {
        islands: { V: "./V.vue", S: "./S.svelte" },
      };
    `);
    expect(result.islands.map((i) => i.source?.framework)).toEqual([
      "vue",
      "svelte",
    ]);
  });

  it("unwraps a parenthesized `as` default export to the object", () => {
    const result = analyze(
      'export default ({ layout: { F: "./F.astro" } }) as const;'
    );
    expect(result.layout).toHaveLength(1);
    expect(result.layout[0]?.key).toBe("F");
  });

  it("returns empty groups when defineComponents gets a non-object arg", () => {
    const result = analyze("export default defineComponents(123);");
    expect(result.mdx).toEqual([]);
    expect(result.layout).toEqual([]);
    expect(result.islands).toEqual([]);
  });

  it("returns empty groups when the default export is not an object shape", () => {
    const result = analyze(`
      const config = 42;
      export default config;
    `);
    expect(result.mdx).toEqual([]);
    expect(result.layout).toEqual([]);
    expect(result.islands).toEqual([]);
  });

  it("resolves a shorthand `component` inside a descriptor object", () => {
    const result = analyze(`
      import component from "./Widget.tsx";
      export default { mdx: { Widget: { component } } };
    `);
    const [widget] = result.mdx;
    expect(widget?.key).toBe("Widget");
    expect(widget?.source?.path).toBe("/project/Widget.tsx");
    expect(widget?.source?.framework).toBe("react");
  });

  it("warns and drops an island whose component can't be resolved", () => {
    const result = analyze("export default { islands: { Counter } };");
    expect(result.islands).toEqual([]);
    expect(result.warnings.join(" ")).toContain(
      "couldn't be resolved to a file"
    );
  });

  it("warns when client: only can't infer a framework", () => {
    const result = analyze(
      'export default { mdx: { Solo: { component: "./Solo.astro", client: "only" } } };'
    );
    expect(result.warnings.join(" ")).toContain('client: "only"');
  });

  it("ignores a spread entry in a group object", () => {
    const result = analyze(`
      const extra = {};
      export default { mdx: { ...extra } };
    `);
    expect(result.mdx).toEqual([]);
  });

  it("ignores an entry with a computed property name", () => {
    const result = analyze(`
      const dynamic = "X";
      export default { mdx: { [dynamic]: "./X.tsx" } };
    `);
    expect(result.mdx).toEqual([]);
  });

  it("resolves a bare identifier value for an override", () => {
    const result = analyze(`
      import MyChart from "./Chart.tsx";
      export default { mdx: { Chart: MyChart } };
    `);
    const [chart] = result.mdx;
    expect(chart?.key).toBe("Chart");
    expect(chart?.identifier).toBe(true);
    expect(chart?.source?.path).toBe("/project/Chart.tsx");
    expect(result.warnings.join(" ")).toContain("no hydration mode");
  });

  it("warns when a descriptor object has no `component` field", () => {
    const result = analyze(`
      export default { mdx: { X: { client: "load" } } };
    `);
    expect(result.mdx).toEqual([]);
    expect(result.warnings.join(" ")).toContain("without a `component` field");
  });

  it("ignores side-effect imports with no import clause", () => {
    const result = analyze(`
      import "./register-globals.ts";
      import Counter from "./Counter.tsx";
      export default { islands: { Counter } };
    `);
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0]?.source?.path).toBe("/project/Counter.tsx");
  });

  it("skips a spread element inside a descriptor object", () => {
    const result = analyze(`
      export default {
        mdx: { Widget: { ...shared, component: "./Widget.tsx", client: "load" } },
      };
    `);
    const [widget] = result.mdx;
    expect(widget?.key).toBe("Widget");
    expect(widget?.client).toBe("load");
    expect(widget?.source?.path).toBe("/project/Widget.tsx");
  });

  it("skips a spread element among the top-level groups", () => {
    const result = analyze(`
      export default { ...base, mdx: { Widget: "./Widget.tsx" } };
    `);
    expect(result.mdx).toHaveLength(1);
    expect(result.mdx[0]?.source?.path).toBe("/project/Widget.tsx");
  });

  it("ignores non-group keys and groups whose value is not an object", () => {
    const result = analyze(`
      export default { theme: { Foo: "./Foo.tsx" }, mdx: 123 };
    `);
    expect(result.mdx).toEqual([]);
    expect(result.layout).toEqual([]);
    expect(result.islands).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps an inline-function override on the runtime object only", () => {
    const result = analyze(`
      export default { mdx: { Widget: () => null } };
    `);
    const [widget] = result.mdx;
    expect(widget?.key).toBe("Widget");
    expect(widget?.identifier).toBe(false);
    expect(widget?.source).toBeNull();
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
      'export default { mdx: { Widget: "./Widget" } };',
      join(dir, "components.ts")
    );
    const [widget] = result.mdx;
    expect(widget?.source?.path).toBe(join(dir, "Widget.tsx"));
    expect(widget?.source?.framework).toBe("react");
  });

  it("keeps an extensionless path unresolved when no file is found", async () => {
    const dir = await makeProject({ "keep.txt": "noop" });
    const result = analyzeComponentOverrides(
      'export default { mdx: { Missing: "./DoesNotExist" } };',
      join(dir, "components.ts")
    );
    const [missing] = result.mdx;
    expect(missing?.source?.path).toBe(join(dir, "DoesNotExist"));
    expect(missing?.source?.framework).toBeNull();
  });
});

describe("planComponentSlots", () => {
  it("returns empty maps when there is no components file", () => {
    const plan = planComponentSlots(null, null);
    expect(plan.wrappers).toEqual([]);
    expect(plan.module).toContain(
      "export const mdxComponents: Record<string, ComponentOverride> = {}"
    );
    expect(plan.module).toContain(
      "export const layoutOverrides: Record<string, ComponentOverride> = {}"
    );
  });

  it("falls back to raw re-exports when analysis is null", () => {
    const plan = planComponentSlots("../../components.ts", null);
    expect(plan.module).toContain("overrides.mdx ?? {}");
    expect(plan.module).toContain("overrides.layout ?? {}");
    expect(plan.wrappers).toEqual([]);
  });

  it("emits a hydration wrapper for an island and folds it into mdx", () => {
    const analysis = analyze(`
      import Counter from "./Counter.tsx";
      export default { islands: { Counter } };
    `);
    const plan = planComponentSlots(FILE, analysis);
    expect(plan.frameworks.has("react")).toBe(true);
    expect(plan.wrappers).toHaveLength(1);
    expect(plan.wrappers[0]?.name).toBe("mdx-Counter");
    expect(plan.wrappers[0]?.content).toContain("client:visible");
    expect(plan.wrappers[0]?.content).toContain("/project/Counter.tsx");
    expect(plan.module).toContain('"Counter":');
  });

  it("imports a static string-path override directly (no wrapper)", () => {
    const analysis = analyze(`
      export default { layout: { Footer: "./footer.astro" } };
    `);
    const plan = planComponentSlots(FILE, analysis);
    expect(plan.wrappers).toEqual([]);
    expect(plan.module).toContain(
      'import __blumeSlot0 from "/project/footer.astro"'
    );
    expect(plan.module).toContain('"Footer": __blumeSlot0');
  });

  it("leaves a bare identifier override on the runtime spread", () => {
    const analysis = analyze(`
      import Footer from "./Footer.astro";
      export default { layout: { Footer } };
    `);
    const plan = planComponentSlots(FILE, analysis);
    expect(plan.wrappers).toEqual([]);
    // No explicit entry — it rides through `...overrides.layout`.
    expect(plan.module).not.toContain("__blumeSlot");
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
    const plan = planComponentSlots(FILE, analysis);
    const contents = plan.wrappers.map((w) => w.content).join("\n");
    expect(contents).toContain('client:media="(min-width: 40rem)"');
    expect(contents).toContain('client:only="react"');
  });

  it("emits client:idle for an idle-hydrated override", () => {
    const plan = planComponentSlots(FILE, mdxAnalysis({ client: "idle" }));
    expect(plan.wrappers[0]?.content).toContain("client:idle");
  });

  it("falls back to client:load when client:media has no media query", () => {
    const plan = planComponentSlots(FILE, mdxAnalysis({ client: "media" }));
    const content = plan.wrappers[0]?.content ?? "";
    expect(content).toContain("client:load");
    expect(content).not.toContain("client:media");
  });

  it("falls back to client:load for client:only without a framework", () => {
    const plan = planComponentSlots(
      FILE,
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
    const plan = planComponentSlots(FILE, mdxAnalysis({ client: "load" }));
    expect(plan.wrappers[0]?.content).toContain("client:load");
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
    const plan = planComponentSlots(FILE, analysis);
    const names = plan.wrappers.map((wrapper) => wrapper.name);
    expect(new Set(names).size).toBe(2);
    // "." is hex-escaped to _2e_ and "_" to _5f_, so the names stay injective.
    expect(names).toContain("mdx-Foo_2e_Bar");
    expect(names).toContain("mdx-Foo_5f_Bar");
    expect(plan.module).toContain("./component-slots/mdx-Foo_2e_Bar.astro");
    expect(plan.module).toContain("./component-slots/mdx-Foo_5f_Bar.astro");
  });
});
