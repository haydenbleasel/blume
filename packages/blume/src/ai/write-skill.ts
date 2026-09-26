import { existsSync } from "node:fs";

import { join, relative, resolve } from "pathe";

import type { BlumeProject } from "../core/project-graph.ts";
import { siteSkillName } from "./site-skill.ts";

/**
 * `blume skill`'s logic, kept out of the command module so it runs (and is
 * covered) in-process. Writing a product skill is judgment work — what the
 * product is, which tasks matter, where it bites — so it lives in the
 * `blume-write-skill` skill, shipped inside the package. This module only
 * works out where the skill goes and writes the prompt that points a coding
 * agent at the skill and the docs.
 */

/** The skill's directory inside the published package. */
export const WRITE_SKILL_DIR = join("skills", "blume-write-skill");

/** Where `agents.skills` points when the config doesn't set it. */
const DEFAULT_SKILLS_DIR = "skills";

/** Where the skill goes, and what the agent needs to know to write it. */
export interface SkillPlan {
  /** The `agents.skills` value to add, when the config has none. */
  configure?: string;
  /** The config file to add it to, relative to the project root. */
  configFile: string;
  /** The content root, relative to the project root. */
  contentRoot: string;
  /** Whether a skill is already there to update. */
  exists: boolean;
  /** Where to write the skill, relative to the project root. */
  file: string;
  /** The skill's name: the generated site skill's, so it replaces it. */
  name: string;
  /** The site's URL, for the skill's absolute links. */
  site?: string;
  title: string;
}

/** Plan the skill for a scanned project. */
export const planSkill = (project: BlumeProject): SkillPlan => {
  const { config, context } = project;
  const name = siteSkillName(project);
  const file = resolve(
    context.root,
    config.agents.skills ?? DEFAULT_SKILLS_DIR,
    name,
    "SKILL.md"
  );
  const plan: SkillPlan = {
    configFile: context.configFile
      ? relative(context.root, context.configFile)
      : "blume.config.ts",
    contentRoot: relative(context.root, context.contentRoot) || ".",
    exists: existsSync(file),
    file: relative(context.root, file),
    name,
    site: config.deployment.options.site,
    title: config.title,
  };
  return config.agents.skills
    ? plan
    : { ...plan, configure: `./${DEFAULT_SKILLS_DIR}` };
};

/** The prompt that hands the plan to a coding agent. */
export const writeSkillPrompt = (
  plan: SkillPlan,
  options: { skillDir: string; version: string }
): string => {
  const { skillDir, version } = options;
  const lines = [
    `Write the agent skill for the ${plan.title} docs, a Blume ${version} site.`,
    "",
    `Follow the blume-write-skill skill: read ${join(skillDir, "SKILL.md")} first and work through its workflow.`,
    "",
    plan.exists
      ? `A skill already exists at ${plan.file}. Update it against the current docs rather than starting over, and keep what's still true.`
      : `Write it to ${plan.file}.`,
    `Its frontmatter \`name\` must be \`${plan.name}\`: that's the name of the skill Blume generates for this site, and a skill with the same name replaces it.`,
  ];
  if (plan.configure) {
    lines.push(
      `Then set \`agents.skills: "${plan.configure}"\` in ${plan.configFile} so the build publishes it.`
    );
  }
  lines.push(
    "",
    `The docs source is in ${plan.contentRoot}.`,
    plan.site
      ? `The site is served at ${plan.site}, so link pages as ${plan.site.replace(/\/$/u, "")}<route>.md.`
      : `The config has no \`deployment.site\`, and the skill's links must be absolute. Ask me for the site's URL, and set it as \`deployment.site\` in ${plan.configFile}.`
  );
  return lines.join("\n");
};
