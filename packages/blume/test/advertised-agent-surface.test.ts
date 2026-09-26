import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildRawMarkdown } from "../src/ai/markdown.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { publishBuildArtifacts } from "../src/deploy/artifacts.ts";

/**
 * The discovery documents — llms.txt, agent-readability.json, the API and AI
 * catalogs, the `_headers` rules — advertise what the build emitted, not
 * what the config asked for: no skills index when nothing was published, no
 * MCP server when a page owns its route and the generator skipped it.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const HOME = "---\ntitle: Home\n---\n# Home\n\nHello.\n";

const SITE = "https://docs.example.com";

/** A plain deployment descriptor for `kind`, as `blume/deploy` resolves one. */
const deployment = (kind: string, output: string): string =>
  `{ kind: "${kind}", options: { output: "${output}", site: "${SITE}" }, requiredSecrets: [], runtimeDeps: [] }`;

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n`;

interface Built {
  dist: string;
  file: (path: string) => Promise<string>;
  root: string;
}

/** Write `files`, scan the project, and publish its artifacts. */
const build = async (
  files: Record<string, string>,
  prepare?: (dist: string) => Promise<void>
): Promise<Built> => {
  const root = await mkdtemp(join(tmpdir(), "blume-advertised-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  await prepare?.(dist);
  const project = await scanProject(root, { mode: "build" });
  await publishBuildArtifacts(
    project,
    dist,
    { info: () => {}, warn: () => {} },
    () => Promise.resolve(0)
  );
  return {
    dist,
    file: (path) => readFile(join(dist, path), "utf-8"),
    root,
  };
};

const SKILLS_INDEX = "/.well-known/agent-skills/index.json";

describe("agent skills in the discovery documents", () => {
  // The generated site skill would publish an index on its own; these cases
  // are about `agents.skills`.
  const config = `export default { agents: { skillMd: false, skills: "skills" }, deployment: ${deployment("netlify", "static")} };\n`;

  it("advertises the skills index when a skill was published", async () => {
    const { file } = await build({
      "blume.config.ts": config,
      "docs/index.md": HOME,
      "skills/simple/SKILL.md": skillMd("simple"),
    });
    expect(await file("llms.txt")).toContain(`${SITE}${SKILLS_INDEX}`);
    const manifest = JSON.parse(await file("agent-readability.json"));
    expect(manifest.artifacts.agentSkills).toBe(`${SITE}${SKILLS_INDEX}`);
    expect(await file("_headers")).toContain("/.well-known/agent-skills/*.md");
  });

  it("leaves it out when the skills directory is missing", async () => {
    const { file } = await build({
      "blume.config.ts": config,
      "docs/index.md": HOME,
    });
    expect(await file("llms.txt")).not.toContain("agent-skills");
    const manifest = JSON.parse(await file("agent-readability.json"));
    expect(manifest.artifacts.agentSkills).toBeUndefined();
    expect(await file("_headers")).not.toContain("agent-skills");
  });

  it("leaves it out when no skill is valid", async () => {
    const { file } = await build({
      "blume.config.ts": config,
      "docs/index.md": HOME,
      "skills/broken/SKILL.md": "# no frontmatter\n",
    });
    expect(await file("llms.txt")).not.toContain("agent-skills");
    const catalog = JSON.parse(await file(".well-known/ai-catalog.json"));
    expect(
      catalog.entries.some((entry: { identifier: string }) =>
        entry.identifier.includes(":skill:")
      )
    ).toBe(false);
  });

  it("keeps advertising an index the user ships", async () => {
    const { file } = await build(
      { "blume.config.ts": config, "docs/index.md": HOME },
      async (dist) => {
        const index = join(dist, SKILLS_INDEX.slice(1));
        await mkdir(dirname(index), { recursive: true });
        await writeFile(index, "{}", "utf-8");
      }
    );
    expect(await file("llms.txt")).toContain(`${SITE}${SKILLS_INDEX}`);
  });
});

describe("the MCP server in the discovery documents", () => {
  const config = `export default { agents: { mcp: { enabled: true } }, deployment: ${deployment("cloudflare", "server")} };\n`;

  it("advertises the server the generator emits", async () => {
    const { file } = await build({
      "blume.config.ts": config,
      "docs/index.md": HOME,
    });
    expect(await file("llms.txt")).toContain(`[MCP server](${SITE}/mcp)`);
    const manifest = JSON.parse(await file("agent-readability.json"));
    expect(manifest.artifacts.mcp?.url).toBe(`${SITE}/mcp`);
    expect(await file(".well-known/api-catalog")).toContain(`${SITE}/mcp`);
    expect(await file("_headers")).toContain("/.well-known/mcp.json");
  });

  it("leaves out a server a content page's route kept from being generated", async () => {
    const { file, root } = await build({
      "blume.config.ts": config,
      "docs/index.md": HOME,
      "docs/mcp.md": "# MCP\n\nHow we use MCP.\n",
    });
    const llms = await file("llms.txt");
    expect(llms).not.toContain("[MCP server]");
    expect(llms).not.toContain("mcp.json");
    const manifest = JSON.parse(await file("agent-readability.json"));
    expect(manifest.artifacts.mcp).toBeUndefined();
    expect(await file(".well-known/api-catalog")).not.toContain(
      `"anchor": "${SITE}/mcp"`
    );
    const catalog = JSON.parse(await file(".well-known/ai-catalog.json"));
    expect(
      catalog.entries.some((entry: { identifier: string }) =>
        entry.identifier.includes(":mcp:")
      )
    ).toBe(false);
    expect(await file("_headers")).not.toContain("/.well-known/mcp");

    // The homepage mirror a landing page gets is llms.txt, and agrees.
    await rm(join(root, "docs", "index.md"));
    const raw = await buildRawMarkdown(
      await scanProject(root, { mode: "build" })
    );
    expect(raw["/"]?.mdx).not.toContain("[MCP server]");
  });
});
