import matter from "../core/frontmatter.ts";
import { TRANSLATABLE_KEY_PATHS } from "./prompts.ts";

/**
 * Structural validation of agent output. The agent is never trusted for
 * structure: the final frontmatter is *reconstructed* from the source (clone
 * the source data, overlay only the translatable string values), so invented
 * keys are dropped, deleted keys are restored, and slugs/icons/orders/dates
 * stay source-verbatim by construction. Only then is the file written.
 */

export type ValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const FRONTMATTER_OPEN = /^---\r?\n/u;
const FENCE_LINE = /^\s*(?:```|~~~)/u;

/**
 * Strip exactly one symmetric outer code fence (any info string) — the one
 * wrapper agents add despite being told not to. Anything else (no fence, or a
 * fence that isn't the entire output) is returned trimmed and untouched.
 */
export const stripOuterFence = (text: string): string => {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^(?<fence>`{3,}|~{3,})[^\n]*\n(?<inner>[\s\S]*?)\n\k<fence>\s*$/u
  );
  return match?.groups?.inner ?? trimmed;
};

/** Lines opening or closing a code fence; their count must survive translation. */
const countFenceLines = (text: string): number =>
  text.split("\n").filter((line) => FENCE_LINE.test(line)).length;

const getPath = (data: unknown, path: readonly string[]): unknown => {
  let value: unknown = data;
  for (const key of path) {
    if (typeof value !== "object" || value === null) {
      return;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

/** Set `path` on `data`; only called for paths whose parents exist in `data`. */
const setPath = (
  data: Record<string, unknown>,
  path: readonly string[],
  value: string
): void => {
  let parent = data;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string, unknown>;
  }
  parent[path.at(-1) as string] = value;
};

const ensureTrailingNewline = (text: string): string =>
  text.endsWith("\n") ? text : `${text}\n`;

/**
 * Validate one translated page against its source and reassemble the file to
 * write. Fails (no write happens) on empty output, unparseable or missing
 * frontmatter, an empty body, or a changed code-fence count.
 */
export const validateTranslation = (
  sourceText: string,
  agentText: string
): ValidationResult => {
  const candidate = stripOuterFence(agentText);
  if (candidate === "") {
    return { ok: false, reason: "agent returned empty output" };
  }

  const sourceHasFrontmatter = FRONTMATTER_OPEN.test(sourceText);
  const source = matter(sourceText);

  if (sourceHasFrontmatter && !FRONTMATTER_OPEN.test(candidate)) {
    return {
      ok: false,
      reason: "translation dropped the frontmatter (must start with ---)",
    };
  }

  let parsed: { content: string; data: Record<string, unknown> };
  try {
    parsed = matter(candidate);
  } catch {
    return { ok: false, reason: "frontmatter does not parse as YAML" };
  }

  const body = ensureTrailingNewline(parsed.content.replace(/^\r?\n/u, ""));
  if (body.trim() === "") {
    return { ok: false, reason: "translation has an empty body" };
  }

  const sourceFences = countFenceLines(source.content);
  const candidateFences = countFenceLines(body);
  if (sourceFences !== candidateFences) {
    return {
      ok: false,
      reason: `code fence count changed (source has ${sourceFences}, translation has ${candidateFences})`,
    };
  }

  if (!sourceHasFrontmatter) {
    // A frontmatter-less source writes the body alone; any frontmatter the
    // agent invented is dropped with it.
    return { ok: true, text: body };
  }

  // Reconciliation by reconstruction: start from the SOURCE data and overlay
  // only the translatable key paths where both sides hold a string and the
  // translation is non-empty.
  const data = structuredClone(source.data) as Record<string, unknown>;
  for (const path of TRANSLATABLE_KEY_PATHS) {
    const original = getPath(source.data, path);
    const translated = getPath(parsed.data, path);
    if (
      typeof original === "string" &&
      typeof translated === "string" &&
      translated.trim() !== ""
    ) {
      setPath(data, path, translated);
    }
  }

  return {
    ok: true,
    text: ensureTrailingNewline(matter.stringify(body, data)),
  };
};

/**
 * Extract translated sidebar titles from a meta reply: tolerant first-`{`
 * to-last-`}` extraction (the eval `parseVerdict` idiom). Keys missing or
 * non-string in the reply land in `missing`, so a batch can partially succeed.
 */
export const parseMetaTitles = (
  agentText: string,
  expectedKeys: readonly string[]
): { titles: Record<string, string>; missing: string[] } => {
  const start = agentText.indexOf("{");
  const end = agentText.lastIndexOf("}");
  let parsed: unknown;
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(agentText.slice(start, end + 1));
    } catch {
      parsed = undefined;
    }
  }
  const record =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  const titles: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of expectedKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      titles[key] = value;
    } else {
      missing.push(key);
    }
  }
  return { missing, titles };
};
