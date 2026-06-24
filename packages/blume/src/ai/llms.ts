import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import matter from "gray-matter";
import { join } from "pathe";
import { glob } from "tinyglobby";

import type { BlumeProject } from "../core/project-graph.ts";
import type { PageRecord } from "../core/types.ts";
import {
  buildPageMarkdown,
  isPublicAgentPage,
  markdownUrlForPage,
  writeMarkdownExports,
} from "./markdown.ts";

interface SkillArtifact {
  content: string;
  description: string;
  name: string;
  slug: string;
}

const pageUrl = (route: string, site?: string): string => {
  if (!site) {
    return route;
  }
  return `${site.replace(/\/$/u, "")}${route}`;
};

const orderedPages = (project: BlumeProject): PageRecord[] =>
  [...project.graph.pages]
    .filter((page) => !page.meta.draft && isPublicAgentPage(page))
    .sort((a, b) => a.route.localeCompare(b.route));

const descriptionSummary = (description: string | undefined): string => {
  if (!description) {
    return "";
  }
  const firstLine = description.split(/\r?\n/u)[0] ?? "";
  const truncated =
    firstLine.length > 300
      ? `${firstLine.slice(0, 300).trimEnd()}...`
      : firstLine;
  return truncated ? `: ${truncated}` : "";
};

const specUrl = (source: string, site?: string): string =>
  source.startsWith("http://") || source.startsWith("https://")
    ? source
    : pageUrl(source.startsWith("/") ? source : `/${source}`, site);

const artifactUrl = (path: string, site?: string): string =>
  site ? `${site.replace(/\/$/u, "")}${path}` : path;

const yamlString = (value: string): string => JSON.stringify(value);

const slugifySkillName = (value: string): string => {
  const slug = value
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  return slug || "default";
};

const withTrailingNewline = (content: string): string =>
  content.endsWith("\n") ? content : `${content}\n`;

const isSkillArtifact = (
  skill: SkillArtifact | undefined
): skill is SkillArtifact => skill !== undefined;

const skillMetadata = (
  content: string,
  fallback: { description: string; name: string }
): Omit<SkillArtifact, "content"> => {
  const parsed = matter(content);
  const name =
    typeof parsed.data.name === "string" && parsed.data.name.length > 0
      ? parsed.data.name
      : fallback.name;
  const description =
    typeof parsed.data.description === "string" &&
    parsed.data.description.length > 0
      ? parsed.data.description
      : fallback.description;
  return {
    description,
    name,
    slug: slugifySkillName(name),
  };
};

const buildGeneratedSkill = (project: BlumeProject): SkillArtifact => {
  const { config } = project;
  const description =
    config.description ??
    `Use this skill when working with the ${config.title} documentation.`;
  const pages = orderedPages(project);
  const lines = [
    "---",
    `name: ${yamlString(slugifySkillName(config.title))}`,
    `description: ${yamlString(description)}`,
    "license: MIT",
    "compatibility: Requires access to the published documentation site.",
    "metadata:",
    "  generator: blume",
    "---",
    "",
    `# ${config.title}`,
    "",
    description,
    "",
    "## Capabilities",
    "",
    "- Find documentation pages and Markdown exports for this product.",
    "- Answer product questions from the published documentation content.",
    "- Link directly to relevant pages when describing workflows or APIs.",
    "",
    "## Workflows",
    "",
    "1. Read `/llms.txt` to discover available documentation pages.",
    "2. Fetch page-level Markdown exports for detailed context.",
    "3. Use the source documentation links when answering implementation questions.",
  ];

  if (pages.length > 0) {
    lines.push("", "## Available documentation", "");
    for (const page of pages) {
      lines.push(
        `- [${page.title}](${markdownUrlForPage(page.route, config.deployment.site)})${descriptionSummary(page.description)}`
      );
    }
  }

  if (config.api.openapi.length > 0 || config.api.asyncapi.length > 0) {
    lines.push("", "## API references", "");
    for (const spec of config.api.openapi) {
      lines.push(`- OpenAPI: ${specUrl(spec.source, config.deployment.site)}`);
    }
    for (const spec of config.api.asyncapi) {
      lines.push(`- AsyncAPI: ${specUrl(spec.source, config.deployment.site)}`);
    }
  }

  const content = `${lines.join("\n")}\n`;
  return {
    content,
    ...skillMetadata(content, {
      description,
      name: slugifySkillName(config.title),
    }),
  };
};

const readSkillArtifact = async (
  project: BlumeProject,
  path: string
): Promise<SkillArtifact | undefined> => {
  try {
    const content = withTrailingNewline(await readFile(path, "utf-8"));
    return {
      content,
      ...skillMetadata(content, {
        description:
          project.config.description ??
          `Use this skill when working with the ${project.config.title} documentation.`,
        name: project.config.title,
      }),
    };
  } catch {
    return undefined;
  }
};

const readCustomSkills = async (
  project: BlumeProject
): Promise<SkillArtifact[]> => {
  const rootSkill = await readSkillArtifact(
    project,
    join(project.context.root, "skill.md")
  );
  const skillPaths = await glob([".mintlify/skills/*/SKILL.md"], {
    cwd: project.context.root,
    followSymbolicLinks: true,
    onlyFiles: true,
  });
  const maybeNestedSkills = await Promise.all(
    skillPaths
      .toSorted((a, b) => a.localeCompare(b))
      .map((path) =>
        readSkillArtifact(project, join(project.context.root, path))
      )
  );
  const nestedSkills = maybeNestedSkills.filter(isSkillArtifact);
  return rootSkill ? [rootSkill, ...nestedSkills] : nestedSkills;
};

/** Build skill.md resources and discovery manifests for the project. */
export const buildSkillArtifacts = async (
  project: BlumeProject
): Promise<SkillArtifact[]> => {
  const custom = await readCustomSkills(project);
  return custom.length > 0 ? custom : [buildGeneratedSkill(project)];
};

const agentSkillsIndex = (skills: SkillArtifact[]): string =>
  `${JSON.stringify(
    {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: skills.map((skill) => ({
        description: skill.description.slice(0, 1024),
        digest: `sha256:${createHash("sha256").update(skill.content).digest("hex")}`,
        name: skill.slug,
        type: "skill-md",
        url: `/.well-known/agent-skills/${skill.slug}/SKILL.md`,
      })),
    },
    null,
    2
  )}\n`;

const skillsIndex = (skills: SkillArtifact[]): string =>
  `${JSON.stringify(
    {
      skills: skills.map((skill) => ({
        description: skill.description,
        files: ["SKILL.md"],
        name: skill.slug,
      })),
    },
    null,
    2
  )}\n`;

const agentCard = (project: BlumeProject, skills: SkillArtifact[]): string => {
  const { config } = project;
  const documentationUrl = artifactUrl("/", config.deployment.site);
  return `${JSON.stringify(
    {
      capabilities: {
        pushNotifications: false,
        streaming: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      description:
        config.description ??
        `Documentation and AI-ready context for ${config.title}.`,
      documentationUrl,
      name: config.title,
      preferredTransport: "HTTP+JSON",
      protocolVersion: "0.3",
      provider: {
        organization: config.title,
        url: documentationUrl,
      },
      skills: skills.map((skill) => ({
        description: skill.description.slice(0, 1024),
        id: skill.slug,
        inputModes: ["text/plain"],
        name: skill.name,
        outputModes: ["text/plain"],
        tags: ["documentation"],
        url: artifactUrl(
          `/.well-known/agent-skills/${skill.slug}/SKILL.md`,
          config.deployment.site
        ),
      })),
      supportedInterfaces: [
        {
          protocolBinding: "HTTP+JSON",
          protocolVersion: "0.3",
          url: documentationUrl,
        },
      ],
      url: documentationUrl,
    },
    null,
    2
  )}\n`;
};

/** Build the compact `llms.txt` index: title, summary, and links per page. */
const buildIndex = (project: BlumeProject): string => {
  const { config } = project;
  const { site } = config.deployment;
  const lines = [`# ${config.title}`];
  if (config.description) {
    lines.push("", `> ${config.description}`);
  }
  lines.push("", "## Docs", "");

  for (const page of orderedPages(project)) {
    const url = markdownUrlForPage(page.route, site);
    lines.push(
      `- [${page.title}](${url})${descriptionSummary(page.description)}`
    );
  }

  if (config.api.openapi.length > 0) {
    lines.push("", "## OpenAPI Specs", "");
    for (const spec of config.api.openapi) {
      lines.push(`- [openapi](${specUrl(spec.source, site)})`);
    }
  }

  if (config.api.asyncapi.length > 0) {
    lines.push("", "## AsyncAPI Specs", "");
    for (const spec of config.api.asyncapi) {
      lines.push(`- [asyncapi](${specUrl(spec.source, site)})`);
    }
  }

  return `${lines.join("\n")}\n`;
};

/** Build `llms-full.txt`: the full Markdown body of every page. */
const buildFull = async (project: BlumeProject): Promise<string> => {
  const { config } = project;
  const pages = orderedPages(project);

  const sections = await Promise.all(
    pages.map(async (page) => {
      const body = await buildPageMarkdown(project, page);
      const url = markdownUrlForPage(page.route, config.deployment.site);
      return [`Source: ${url}`, "", body.trim()].join("\n");
    })
  );

  const header = config.description
    ? `# ${config.title}\n\n> ${config.description}\n`
    : `# ${config.title}\n`;

  return `${header}\n${sections.join("\n\n---\n\n")}\n`;
};

/** Build both LLM text artifacts for a project. */
export const buildLlmsFiles = async (
  project: BlumeProject
): Promise<{ index: string; full: string }> => ({
  full: await buildFull(project),
  index: buildIndex(project),
});

/** Write llms files and page-level Markdown exports into a public directory. */
export const writeLlmsArtifacts = async (
  project: BlumeProject,
  outDir: string
): Promise<{ markdownPages: number }> => {
  const [{ full, index }, markdownPages, skills] = await Promise.all([
    buildLlmsFiles(project),
    writeMarkdownExports(project, outDir),
    buildSkillArtifacts(project),
  ]);
  const wellKnown = join(outDir, ".well-known");
  const agentSkillsRoot = join(wellKnown, "agent-skills");
  const skillsRoot = join(wellKnown, "skills");
  await Promise.all([
    mkdir(agentSkillsRoot, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
    ...skills.flatMap((skill) => [
      mkdir(join(agentSkillsRoot, skill.slug), { recursive: true }),
      mkdir(join(skillsRoot, skill.slug), { recursive: true }),
    ]),
  ]);
  await Promise.all([
    writeFile(join(outDir, "llms.txt"), index, "utf-8"),
    writeFile(join(outDir, "llms-full.txt"), full, "utf-8"),
    writeFile(join(outDir, "skill.md"), skills[0]?.content ?? "", "utf-8"),
    writeFile(
      join(wellKnown, "agent-card.json"),
      agentCard(project, skills),
      "utf-8"
    ),
    writeFile(join(wellKnown, "llms.txt"), index, "utf-8"),
    writeFile(join(wellKnown, "llms-full.txt"), full, "utf-8"),
    writeFile(
      join(agentSkillsRoot, "index.json"),
      agentSkillsIndex(skills),
      "utf-8"
    ),
    writeFile(join(skillsRoot, "index.json"), skillsIndex(skills), "utf-8"),
    ...skills.flatMap((skill) => [
      writeFile(
        join(agentSkillsRoot, skill.slug, "SKILL.md"),
        skill.content,
        "utf-8"
      ),
      writeFile(
        join(skillsRoot, skill.slug, "skill.md"),
        skill.content,
        "utf-8"
      ),
    ]),
  ]);
  return { markdownPages };
};
