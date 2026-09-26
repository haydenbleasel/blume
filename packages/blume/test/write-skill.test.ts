import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import {
  planSkill,
  WRITE_SKILL_DIR,
  writeSkillPrompt,
} from "../src/ai/write-skill.ts";
import type { SkillPlan } from "../src/ai/write-skill.ts";
import { scanProject } from "../src/core/project-graph.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const DEPLOYMENT = '{ site: "https://docs.example.com/" }';

/** Scan a project written from `files` and plan its skill. */
const plan = async (files: Record<string, string>): Promise<SkillPlan> => {
  const root = await mkdtemp(join(tmpdir(), "blume-write-skill-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  return planSkill(await scanProject(root, { mode: "build" }));
};

describe(planSkill, () => {
  it("plans a new skill under ./skills, named like the generated one", async () => {
    expect(
      await plan({
        "blume.config.ts": `export default { title: "Acme Docs", deployment: ${DEPLOYMENT} };\n`,
        "docs/index.md": "# Home\n",
      })
    ).toStrictEqual({
      configFile: "blume.config.ts",
      configure: "./skills",
      contentRoot: "docs",
      exists: false,
      file: "skills/acme-docs/SKILL.md",
      name: "acme-docs",
      site: "https://docs.example.com/",
      title: "Acme Docs",
    });
  });

  it("updates a skill already in agents.skills", async () => {
    const found = await plan({
      "agent-skills/acme/SKILL.md": "---\nname: acme\n---\n",
      "blume.config.ts": `export default { title: "Acme", agents: { skills: "./agent-skills" } };\n`,
      "docs/index.md": "# Home\n",
    });
    expect(found).toMatchObject({
      exists: true,
      file: "agent-skills/acme/SKILL.md",
    });
    expect(found.configure).toBeUndefined();
    expect(found.site).toBeUndefined();
  });

  it("names a config file it can't find as blume.config.ts", async () => {
    const found = await plan({ "docs/index.md": "# Home\n" });
    expect(found.configFile).toBe("blume.config.ts");
  });
});

describe(writeSkillPrompt, () => {
  const base: SkillPlan = {
    configFile: "blume.config.ts",
    contentRoot: "docs",
    exists: false,
    file: "skills/acme/SKILL.md",
    name: "acme",
    site: "https://docs.example.com/",
    title: "Acme",
  };
  const options = {
    skillDir: "/pkg/skills/blume-write-skill",
    version: "2.1.0",
  };

  it("points at the skill, the target, the name, and the site", () => {
    expect(writeSkillPrompt({ ...base, configure: "./skills" }, options))
      .toBe(`Write the agent skill for the Acme docs, a Blume 2.1.0 site.

Follow the blume-write-skill skill: read /pkg/skills/blume-write-skill/SKILL.md first and work through its workflow.

Write it to skills/acme/SKILL.md.
Its frontmatter \`name\` must be \`acme\`: that's the name of the skill Blume generates for this site, and a skill with the same name replaces it.
Then set \`agents.skills: "./skills"\` in blume.config.ts so the build publishes it.

The docs source is in docs.
The site is served at https://docs.example.com/, so link pages as https://docs.example.com<route>.md.`);
  });

  it("updates an existing skill, and asks for a missing site", () => {
    const prompt = writeSkillPrompt(
      { ...base, exists: true, site: undefined },
      options
    );
    expect(prompt).toContain(
      "A skill already exists at skills/acme/SKILL.md. Update it against the current docs"
    );
    expect(prompt).toContain("Ask me for the site's URL");
    expect(prompt).not.toContain("agents.skills");
  });

  it("ships the skill it points at", () => {
    expect(WRITE_SKILL_DIR).toBe(join("skills", "blume-write-skill"));
  });
});
