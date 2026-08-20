import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";

import { join } from "pathe";

import { normalizeBasePath } from "../core/base-path.ts";
import matter from "../core/frontmatter.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { buildTarGz } from "./tar.ts";
import type { TarEntry } from "./tar.ts";

/**
 * Agent Skills discovery (Cloudflare's Agent Skills Discovery RFC v0.2.0):
 * the skills a site publishes are enumerated in an index at
 * `/.well-known/agent-skills/index.json`, each entry pointing at its artifact
 * with a SHA-256 digest. A skill that is only a `SKILL.md` publishes the file
 * verbatim (`type: "skill-md"`); a skill with supporting resources (scripts,
 * references, assets) is bundled into a deterministic `.tar.gz`
 * (`type: "archive"`) so its relative references resolve after unpacking.
 */

export const AGENT_SKILLS_DIR = "/.well-known/agent-skills";
export const AGENT_SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";

const AGENT_SKILLS_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** Skill naming rule from the Agent Skills spec (1-64 chars enforced apart). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_NAME_MAX = 64;
/** The Agent Skills spec caps `description` at 1024 characters. */
const DESCRIPTION_MAX = 1024;

/** One publishable skill artifact plus its index entry. */
export interface SkillArtifact {
  /** Raw bytes to publish (the digest is computed over exactly these). */
  content: Uint8Array;
  description: string;
  /** `sha256:{hex}` digest of `content`. */
  digest: string;
  name: string;
  /** Path under the agent-skills dir: `{name}/SKILL.md` or `{name}.tar.gz`. */
  path: string;
  type: "archive" | "skill-md";
}

export interface CollectedSkills {
  skills: SkillArtifact[];
  /** Human-readable reasons for anything skipped. */
  warnings: string[];
}

const sha256 = (content: Uint8Array): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

/**
 * Every regular file under a skill directory, as archive entries with
 * `/`-separated relative paths, dotfiles (`.DS_Store`, `.git`) excluded,
 * sorted for deterministic archives. The owner-execute bit is preserved so a
 * skill's scripts stay runnable after unpacking.
 */
const collectEntries = async (
  dir: string,
  prefix = ""
): Promise<TarEntry[]> => {
  const entries: TarEntry[] = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (item.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, item.name);
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      // Sequential recursion keeps ordering deterministic.
      // oxlint-disable-next-line no-await-in-loop
      entries.push(...(await collectEntries(path, relative)));
    } else if (item.isFile()) {
      // oxlint-disable-next-line no-await-in-loop
      const [content, info] = await Promise.all([readFile(path), stat(path)]);
      entries.push({
        content: new Uint8Array(content),
        // oxlint-disable-next-line no-bitwise -- testing the owner-execute mode bit
        executable: (info.mode & 0o100) !== 0,
        path: relative,
      });
    }
  }
  return entries;
};

/** The two SKILL.md frontmatter fields the discovery index publishes. */
interface SkillMeta {
  description: string;
  name: string;
}

interface SkillMetaResult {
  meta: SkillMeta | null;
  warning?: string;
}

/**
 * What js-yaml can put in a SKILL.md frontmatter field. Rich scalars (Dates)
 * ride along as the object arm; only strings are accepted below anyway.
 */
type FrontmatterField =
  | string
  | number
  | boolean
  | null
  | undefined
  | FrontmatterField[]
  | { [key: string]: FrontmatterField };

const isString = (value: FrontmatterField): value is string =>
  typeof value === "string";

/** Frontmatter of a SKILL.md, or null with a warning when unusable. */
const skillMeta = (raw: string, dirName: string): SkillMetaResult => {
  let data: { description?: FrontmatterField; name?: FrontmatterField };
  try {
    ({ data } = matter(raw));
  } catch {
    return {
      meta: null,
      warning: `Skill "${dirName}" has unparsable SKILL.md frontmatter; skipped.`,
    };
  }
  const name = isString(data.name) ? data.name : "";
  const description = isString(data.description) ? data.description : "";
  if (!(name && description)) {
    return {
      meta: null,
      warning: `Skill "${dirName}" is missing the required "name"/"description" frontmatter; skipped.`,
    };
  }
  if (!SKILL_NAME.test(name) || name.length > SKILL_NAME_MAX) {
    return {
      meta: null,
      warning: `Skill "${dirName}" has an invalid name "${name}" (lowercase alphanumerics and single hyphens, max 64 chars); skipped.`,
    };
  }
  return {
    meta: { description: description.slice(0, DESCRIPTION_MAX), name },
  };
};

/**
 * Collect the publishable skills from a directory whose subdirectories each
 * hold a `SKILL.md` (the layout `npx skills add` consumes). Subdirectories
 * without one are ignored silently — the directory may hold other assets —
 * while a present-but-invalid skill earns a warning so it isn't dropped
 * behind the publisher's back.
 */
export const collectSkills = async (dir: string): Promise<CollectedSkills> => {
  const skills: SkillArtifact[] = [];
  const warnings: string[] = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!item.isDirectory() || item.name.startsWith(".")) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const entries = await collectEntries(join(dir, item.name));
    const skillMd = entries.find((entry) => entry.path === "SKILL.md");
    if (!skillMd) {
      continue;
    }
    const { meta, warning } = skillMeta(
      new TextDecoder().decode(skillMd.content),
      item.name
    );
    if (!meta) {
      if (warning) {
        warnings.push(warning);
      }
      continue;
    }
    // A lone SKILL.md ships verbatim; supporting resources ship as an
    // archive so the skill's relative references resolve after unpacking.
    const single = entries.length === 1;
    const content = single ? skillMd.content : buildTarGz(entries);
    skills.push({
      content,
      description: meta.description,
      digest: sha256(content),
      name: meta.name,
      path: single ? `${meta.name}/SKILL.md` : `${meta.name}.tar.gz`,
      type: single ? "skill-md" : "archive",
    });
  }
  return { skills, warnings };
};

/**
 * The discovery index (v0.2.0 schema). Artifact URLs are path-absolute under
 * `deployment.base` — the RFC resolves them against the index origin.
 */
export const buildSkillsIndex = (
  skills: readonly SkillArtifact[],
  config: ResolvedConfig
): string => {
  const deployBase = normalizeBasePath(config.deployment.base);
  const index = {
    $schema: AGENT_SKILLS_SCHEMA,
    skills: skills.map((skill) => ({
      description: skill.description,
      digest: skill.digest,
      name: skill.name,
      type: skill.type,
      url: `${deployBase}${AGENT_SKILLS_DIR}/${skill.path}`,
    })),
  };
  return `${JSON.stringify(index, null, 2)}\n`;
};
