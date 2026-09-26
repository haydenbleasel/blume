import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  buildSiteSkill,
  MAX_SKILL_PAGES,
  siteSkillName,
} from "../src/ai/site-skill.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { publishBuildArtifacts } from "../src/deploy/artifacts.ts";
import { openapi, scalar } from "../src/reference/index.ts";

/**
 * The generated site skill (`agents.skillMd`): a SKILL.md built from the
 * site's navigation and agent surfaces, published in the skills index and at
 * `/skill.md`, unless a same-named hand-written skill replaces it.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const SITE = "https://docs.example.com";

/** A plain deployment descriptor for `kind`, as `blume/deploy` resolves one. */
const deployment = (kind: string, output: string, site = SITE): string =>
  `{ kind: "${kind}", options: { output: "${output}"${site ? `, site: "${site}"` : ""} }, requiredSecrets: [], runtimeDeps: [] }`;

const page = (title: string, extra = ""): string =>
  `---\ntitle: ${title}\n${extra}---\n# ${title}\n\nBody.\n`;

const PAGES = {
  "docs/guides/index.md": page("Guides", "description: How-tos.\n"),
  "docs/guides/setup.md": page("Setup [beta]", "description: Install Acme.\n"),
  "docs/index.md": page("Home", "description: Start here.\n"),
  "docs/releases/v1.md": page("v1", "type: changelog\ndate: 2026-01-01\n"),
  "docs/secret.md": page("Secret", "sidebar:\n  hidden: true\n"),
};

/** The default config: a titled, described static site with a `site`. */
const config = (agents = "{}", extra = ""): string =>
  `export default { title: "Acme", description: "Build things with Acme.", agents: ${agents}, deployment: ${deployment("netlify", "static")}${extra} };\n`;

/** Write `files` to a fresh project and scan it. */
const project = async (
  files: Record<string, string>
): Promise<{ project: BlumeProject; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "blume-site-skill-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  return { project: await scanProject(root, { mode: "build" }), root };
};

interface Built {
  file: (path: string) => Promise<string>;
  has: (path: string) => Promise<boolean>;
}

/** Scan `files` and publish the build artifacts into a fresh dist. */
const build = async (
  files: Record<string, string>,
  prepare?: (dist: string) => Promise<void>
): Promise<Built> => {
  const scanned = await project(files);
  const dist = join(scanned.root, "dist");
  await mkdir(dist, { recursive: true });
  await prepare?.(dist);
  await publishBuildArtifacts(
    scanned.project,
    dist,
    { info: () => {}, warn: () => {} },
    () => Promise.resolve(0)
  );
  const file = (path: string) => readFile(join(dist, path), "utf-8");
  return {
    file,
    has: (path) =>
      file(path).then(
        () => true,
        () => false
      ),
  };
};

/** The generated skill's Markdown for a project. */
const skillOf = (scanned: BlumeProject): string =>
  new TextDecoder().decode(buildSiteSkill(scanned)?.content);

const INDEX = ".well-known/agent-skills/index.json";

describe("the generated site skill", () => {
  it("maps the docs and serves the skill at /skill.md and in the index", async () => {
    const { file } = await build({ "blume.config.ts": config(), ...PAGES });
    const skill = await file("skill.md");
    expect(await file(".well-known/agent-skills/acme/SKILL.md")).toBe(skill);
    expect(skill).toStartWith(
      '---\nname: acme\ndescription: "Read the Acme docs instead of answering from memory. Build things with Acme. Use when a task involves Acme: how it works, how to set it up or configure it, or its API."\n---\n\n# Acme\n\nBuild things with Acme.\n'
    );
    expect(skill).toContain(
      `- Any page as Markdown: add \`.md\` to its URL (the home page is ${SITE}/index.md).`
    );
    expect(skill).toContain(`- [llms.txt](${SITE}/llms.txt)`);
    expect(skill).toContain(`- [JSON API](${SITE}/api/docs/pages.json)`);
    expect(skill).toContain(
      `- [Changelog](${SITE}/changelog.md): release notes, newest first.`
    );
    expect(skill).toContain(
      `### Guides\n\n- [Guides](${SITE}/guides.md): How-tos.\n- [Setup \\[beta\\]](${SITE}/guides/setup.md): Install Acme.`
    );
    // Changelog entries and hidden pages stay out of the map.
    expect(skill).not.toContain("releases/v1");
    expect(skill).not.toContain("secret");
    expect(skill).not.toContain("MCP server");

    const index = JSON.parse(await file(INDEX));
    expect(index.skills).toMatchObject([
      {
        name: "acme",
        type: "skill-md",
        url: "/.well-known/agent-skills/acme/SKILL.md",
      },
    ]);
    expect(await file("llms.txt")).toContain(
      `- [acme](${SITE}/.well-known/agent-skills/acme/SKILL.md): Read the Acme docs`
    );
    expect(await file(".well-known/ai-catalog.json")).toContain(
      "urn:air:docs.example.com:skill:acme"
    );
  });

  it("maps pages up to its cap, then points at llms.txt", async () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_SKILL_PAGES + 2 }, (_, index) => [
        `docs/p${String(index).padStart(3, "0")}.md`,
        page(`Page ${index}`),
      ])
    );
    const { project: scanned } = await project({
      "blume.config.ts": config(
        "{}",
        ', navigation: { sidebar: [{ label: "Some", items: ["/p000"] }] }'
      ),
      ...many,
    });
    const skill = skillOf(scanned);
    expect(skill.match(/^- \[Page /gmu)).toHaveLength(MAX_SKILL_PAGES);
    expect(skill).toContain(`### Some\n\n- [Page 0](${SITE}/p000.md)`);
    expect(skill).toContain(
      `…and 2 more. [llms.txt](${SITE}/llms.txt) lists every page.`
    );
    const withoutLlms = skillOf({
      ...scanned,
      config: {
        ...scanned.config,
        agents: {
          ...scanned.config.agents,
          llmsTxt: { enabled: false, openapi: true },
        },
      },
    });
    expect(withoutLlms).toContain("…and 2 more.\n");
    expect(withoutLlms).not.toContain("llms.txt");
  });

  it("lists API references and the MCP server the build serves", async () => {
    const { project: scanned } = await project({
      "blume.config.ts": config("{ mcp: { enabled: true } }"),
      "docs/index.md": page("Home"),
    });
    const skill = skillOf({
      ...scanned,
      config: {
        ...scanned.config,
        reference: blumeConfigSchema.parse({
          reference: [
            openapi({ route: "/reference", spec: "./openapi.json" }),
            scalar({ route: "/graph", spec: "./graph.json" }),
          ],
        }).reference,
      },
    });
    expect(skill).toContain(
      `- MCP server at ${SITE}/mcp, with \`search_docs\``
    );
    expect(skill).toContain(
      `- [API Reference](${SITE}/reference), with a page per operation (add \`.md\` for its Markdown).\n- [API Reference](${SITE}/graph).`
    );

    // A page on the MCP route keeps the server from being generated.
    const { file } = await build({
      "blume.config.ts": `export default { title: "Acme", agents: { mcp: { enabled: true } }, deployment: ${deployment("cloudflare", "server")} };\n`,
      "docs/index.md": page("Home"),
      "docs/mcp.md": page("MCP"),
    });
    expect(await file("skill.md")).not.toContain("MCP server");
  });

  it("gives way to a hand-written skill of the same name", async () => {
    const mine =
      "---\nname: acme\ndescription: My own Acme skill.\n---\n\n# Mine\n";
    const single = await build({
      "blume.config.ts": config('{ skills: "skills" }'),
      ...PAGES,
      "skills/acme/SKILL.md": mine,
    });
    expect(await single.file("skill.md")).toBe(mine);
    const index = JSON.parse(await single.file(INDEX));
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0].description).toBe("My own Acme skill.");

    // An archive's references need its other files, so /skill.md is left out.
    const archive = await build({
      "blume.config.ts": config('{ skills: "skills" }'),
      ...PAGES,
      "skills/acme/SKILL.md": mine,
      "skills/acme/references/more.md": "# More\n",
    });
    expect(await archive.has("skill.md")).toBe(false);
    expect(await archive.has(".well-known/agent-skills/acme.tar.gz")).toBe(
      true
    );
  });

  it("leaves a shipped skill.md or skills index alone", async () => {
    const shipped = await build(
      { "blume.config.ts": config(), ...PAGES },
      (dist) => writeFile(join(dist, "skill.md"), "mine", "utf-8")
    );
    expect(await shipped.file("skill.md")).toBe("mine");

    const index = await build(
      { "blume.config.ts": config(), ...PAGES },
      async (dist) => {
        await mkdir(join(dist, ".well-known/agent-skills"), {
          recursive: true,
        });
        await writeFile(join(dist, INDEX), "{}", "utf-8");
      }
    );
    expect(await index.file(INDEX)).toBe("{}");
    expect(await index.has("skill.md")).toBe(false);
  });

  it("is off with skillMd: false, or with no site to link", async () => {
    const off = await build({
      "blume.config.ts": config("{ skillMd: false }"),
      ...PAGES,
    });
    expect(await off.has("skill.md")).toBe(false);
    expect(await off.has(INDEX)).toBe(false);
    expect(await off.file("llms.txt")).not.toContain("agent-skills");

    const siteless = await build({
      "blume.config.ts": `export default { title: "Acme", deployment: ${deployment("netlify", "static", "")} };\n`,
      ...PAGES,
    });
    expect(await siteless.has("skill.md")).toBe(false);
  });
});

describe(siteSkillName, () => {
  it("names the skill after the title, else the site's host", async () => {
    const titled = await project({
      "blume.config.ts": `export default { title: "Äcme Docs — ${"x".repeat(70)}!", deployment: ${deployment("netlify", "static")} };\n`,
      "docs/index.md": page("Home"),
    });
    expect(siteSkillName(titled.project)).toBe(`acme-docs-${"x".repeat(54)}`);
    const host = { ...titled.project.config, title: "ドキュメント" };
    expect(siteSkillName({ ...titled.project, config: host })).toBe(
      "docs-example-com"
    );
    const nothing = {
      ...host,
      deployment: {
        ...host.deployment,
        options: { ...host.deployment.options, site: "" },
      },
    };
    expect(siteSkillName({ ...titled.project, config: nothing })).toBe("docs");
  });
});
