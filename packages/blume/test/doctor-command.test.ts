import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { filesystem } from "../src/sources/filesystem.ts";
import { notion } from "../src/sources/notion.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-doctor-command-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const doctor = async (
  root: string,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
  const proc = Bun.spawn([process.execPath, CLI, "doctor", ...args], {
    cwd: root,
    env: { ...process.env, CONSOLA_LEVEL: "3" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const HOME = { "docs/index.mdx": "---\ntitle: Home\n---\n# Home\n" };

describe("blume doctor", () => {
  it("reports no problems for a healthy project", async () => {
    const root = await makeProject(HOME);
    const { exitCode, stderr, stdout } = await doctor(root);
    expect(exitCode).toBe(0);
    expect(`${stdout}${stderr}`).toContain("No problems found.");
  });

  it("plans components.ts and reports an override it can't plan, with its line", async () => {
    const root = await makeProject({
      ...HOME,
      "components.ts": `import Callout from "./components/Callout.astro";

export default {
  mdx: { Callout },
};
`,
    });
    const { exitCode, stderr } = await doctor(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("BLUME_COMPONENTS_INVALID");
    expect(stderr).toContain("components.ts:");
    expect(stderr).not.toContain("No problems found.");
  });

  it("includes components.ts issues in --json", async () => {
    const root = await makeProject({
      ...HOME,
      "components.ts": "export default { mdx: { Callout: () => null } };\n",
    });
    const { exitCode, stdout } = await doctor(root, "--json");
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout);
    expect(
      report.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)
    ).toContain("BLUME_COMPONENTS_INVALID");
  });

  it("reports navigation entries that point at missing pages, as dev and build do", async () => {
    const root = await makeProject({
      ...HOME,
      "blume.config.ts": `export default {
  navigation: {
    featured: [{ label: "Missing", href: "/missing" }],
    selectors: [
      {
        items: [{ label: "SDK", path: "/sdk" }],
        kind: "product",
        label: "Product",
      },
    ],
    tabs: [
      { label: "Guides", path: "/guides" },
      { label: "Custom", path: "/custom" },
      { label: "Gone", path: "/gone" },
    ],
  },
};
`,
      "docs/guides/setup.mdx": "---\ntitle: Setup\n---\n# Setup\n",
      "pages/custom.astro": "<h1>Custom</h1>\n",
    });
    const { exitCode, stderr } = await doctor(root);
    expect(exitCode).toBe(0);
    for (const [label, path] of [
      ["Gone", "/gone"],
      ["SDK", "/sdk"],
      ["Missing", "/missing"],
    ]) {
      expect(stderr).toContain(
        `Navigation entry "${label}" points to ${path}, but no page matches it.`
      );
    }
    expect(stderr).not.toContain('"Guides" points');
    expect(stderr).not.toContain('"Custom" points');
  });

  it("reports a <Component path> that names no example, at its line", async () => {
    const root = await makeProject({
      "docs/index.mdx": [
        "---",
        "title: Home",
        "---",
        "# Home",
        "",
        '<Component path="counter" />',
        "",
        '<Component path="forms/missing" />',
      ].join("\n"),
      "examples/counter.astro": "<p>Counter</p>\n",
    });
    const { exitCode, stderr } = await doctor(root);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("BLUME_EXAMPLE_NOT_FOUND");
    expect(stderr).toContain('<Component path="forms/missing">');
    expect(stderr).toContain("docs/index.mdx:8:18");
    expect(stderr).not.toContain('<Component path="counter">');
  });

  it("leaves <Component> alone when components.ts replaces it", async () => {
    const root = await makeProject({
      "components.ts": `import Component from "./components/Component.astro";

export default { mdx: { Component } };
`,
      "components/Component.astro": "<slot />\n",
      "docs/index.mdx":
        '---\ntitle: Home\n---\n# Home\n\n<Component path="anything" />\n',
    });
    const { exitCode, stderr, stdout } = await doctor(root);
    expect(exitCode).toBe(0);
    expect(`${stdout}${stderr}`).toContain("No problems found.");
  });

  it("warns about a version-shaped folder when versioning isn't configured", async () => {
    const root = await makeProject({
      ...HOME,
      "docs/v1.0/index.mdx": "---\ntitle: Old\n---\n# Old\n",
    });
    const { exitCode, stderr } = await doctor(root);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("BLUME_VERSIONS_UNCONFIGURED_VERSION");
    expect(stderr).toContain('Folder "v1.0/" looks like a version snapshot');
  });

  it("names a source's unset token before the source fetches", async () => {
    const root = await makeProject({
      ...HOME,
      "blume.config.ts": `export default {
  content: {
    sources: [
      ${JSON.stringify(filesystem({ root: "docs" }))},
      ${JSON.stringify(notion({ database: "db", prefix: "notes" }))},
    ],
  },
};
`,
    });
    const { NOTION_TOKEN: _unset, ...env } = process.env;
    const proc = Bun.spawn([process.execPath, CLI, "doctor", "--json"], {
      cwd: root,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout);
    // The warning is collected before the scan, and the source stops before
    // its first request instead of failing on Notion's 401.
    expect(
      report.diagnostics.map(
        (diagnostic: { message: string; severity: string }) =>
          `${diagnostic.severity}: ${diagnostic.message}`
      )
    ).toStrictEqual([
      "warning: Content source (notion) is enabled but NOTION_TOKEN is not set.",
      'error: Source "notes" needs NOTION_TOKEN, which is not set.',
    ]);
  });
});
