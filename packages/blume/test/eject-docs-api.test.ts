import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { node } from "../src/deploy/adapters/index.ts";
import { eject } from "../src/registry/eject.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A fresh project dir holding `files` (paths relative to it). */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-eject-api-"));
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

const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), "utf-8");

const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

describe("eject JSON docs API", () => {
  it("serves the prerendered API and its OpenAPI description", async () => {
    // The ejected llms.txt, homepage Link header, and 404 page advertise
    // these routes (agents.api is on by default), so the app must serve them.
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    expect(has(root, "src/pages/api/docs/pages.json.ts")).toBe(true);
    expect(has(root, "src/pages/api/docs/pages/[...route].json.ts")).toBe(true);
    expect(has(root, "src/pages/api/docs/navigation.json.ts")).toBe(true);
    // The endpoints read the agent snapshot the ejected config aliases to
    // `blume:mcp-data`, written even though the MCP server is off.
    expect(read(root, "src/pages/api/docs/pages.json.ts")).toContain(
      'import data from "blume:mcp-data";'
    );
    expect(has(root, "src/generated/mcp-data.json")).toBe(true);
    expect(has(root, "src/blume-mcp/discovery.ts")).toBe(false);
    const spec = read(root, "src/pages/openapi.json.ts");
    expect(spec).toContain('"/api/docs/pages.json": {');
    // Live endpoints need server output; this build is static.
    expect(spec).not.toContain('"/api/docs/search": {');
    expect(has(root, "src/pages/api/docs/search.ts")).toBe(false);
    expect(has(root, "src/pages/api/[...path].ts")).toBe(false);
  });

  it("adds the live endpoints on server output and names the MCP route", async () => {
    const root = await project({
      "blume.config.ts": `export default {
  agents: { mcp: { enabled: true, route: "/docs-mcp" } },
  deployment: ${JSON.stringify(node({ site: "https://example.com" }))},
};
`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    expect(has(root, "src/pages/api/docs/search.ts")).toBe(true);
    expect(read(root, "src/pages/api/[...path].ts")).toContain(
      '{"base":"","site":"https://example.com"}'
    );
    const spec = read(root, "src/pages/openapi.json.ts");
    expect(spec).toContain('"/api/docs/search": {');
    expect(spec).toContain('"/docs-mcp": {');
    expect(has(root, "src/blume-mcp/discovery.ts")).toBe(true);
  });

  it("yields the catch-all and the spec to routes the project owns", async () => {
    const root = await project({
      "blume.config.ts": `export default {
  deployment: ${JSON.stringify(node())},
};
`,
      "docs/api/overview.md": "---\ntitle: API\n---\n# API overview\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "public/openapi.json": "{}\n",
    });

    await eject(root);

    // `/api/[...path]` would outrank the content catch-all for `/api/overview`.
    expect(has(root, "src/pages/api/[...path].ts")).toBe(false);
    expect(has(root, "src/pages/openapi.json.ts")).toBe(false);
    expect(has(root, "src/pages/api/docs/search.ts")).toBe(true);
  });

  it("leaves the catch-all to a user rest route under /api/", async () => {
    const root = await project({
      "blume.config.ts": `export default {
  deployment: ${JSON.stringify(node())},
};
`,
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
      "pages/api/[...all].astro": "<p>mine</p>\n",
    });

    await eject(root);

    expect(has(root, "src/pages/api/[...path].ts")).toBe(false);
    expect(has(root, "src/pages/api/docs/pages.json.ts")).toBe(true);
  });

  it("writes no API and no snapshot when agents.api and MCP are off", async () => {
    const root = await project({
      "blume.config.ts": "export default { agents: { api: false } };\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    expect(has(root, "src/pages/api/docs/pages.json.ts")).toBe(false);
    expect(has(root, "src/pages/openapi.json.ts")).toBe(false);
    expect(has(root, "src/generated/mcp-data.json")).toBe(false);
  });
});

describe("eject include graph", () => {
  it("writes the partial map relative to the project", async () => {
    const root = await project({
      "blume.config.ts": "export default {};\n",
      "docs/_snippets/setup.md": "Shared setup steps.\n",
      "docs/guide.md":
        "---\ntitle: Guide\n---\n# Guide\n\n<include>./_snippets/setup.md</include>\n",
      "docs/index.md": "---\ntitle: Home\n---\n# Home\n",
    });

    await eject(root);

    // No path from the machine that ran eject: the app builds from any
    // checkout, and its readers resolve each entry against the project.
    expect(JSON.parse(read(root, "src/generated/includes.json"))).toEqual({
      "docs/_snippets/setup.md": ["docs/guide.md"],
    });
  });
});
