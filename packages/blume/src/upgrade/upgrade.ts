import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { join, relative } from "pathe";
import { z } from "zod";

import {
  analyzeComponentOverrides,
  ComponentOverridesError,
} from "../core/component-overrides.ts";
import { ConfigValidationError, loadConfig } from "../core/config.ts";
import { BlumeError } from "../core/diagnostics.ts";
import { findComponentsFile, findConfigFile } from "../core/project.ts";
import type { Diagnostic } from "../core/types.ts";

/**
 * `blume upgrade`'s logic, kept out of the command module so it runs (and is
 * covered) in-process: bump the `blume` dependency to the running CLI's major,
 * then check the project against it — the config through the same loader
 * every command uses, which names each removed or renamed field and its
 * replacement, `components.ts` through the same static planner the build
 * runs, and each page's front matter for fields the schema removed. The
 * command prints the findings or hands them to a coding agent.
 */

/** The upgrade guide's route on the Blume docs site. */
export const UPGRADE_GUIDE_URL = "https://useblume.dev/docs/upgrading";

/** The upgrade guide's file inside the published package's bundled docs. */
export const UPGRADE_GUIDE_FILE = join("docs", "03-upgrading.mdx");

/** What `bumpBlumeDependency` did to `package.json`. */
export type DependencyBump =
  | {
      field: DependencyField;
      from: string;
      status: "bumped";
      to: string;
    }
  | { range: string; status: "current" }
  | { range: string; status: "manual" }
  | { status: "missing" };

type DependencyField = "dependencies" | "devDependencies";

const DEPENDENCY_FIELDS: DependencyField[] = [
  "dependencies",
  "devDependencies",
];

/** The slice of `package.json` the bump reads and rewrites. */
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// Leading comparators and a `v` may precede the major (`^1.7.3`, `>=1 <2`,
// `v1`); a protocol (`workspace:`, `file:`, `npm:`) or a tag (`latest`) names
// no major at all, and those ranges are left to the user.
const RANGE_MAJOR = /^[\s<=>^~v]*(?<major>\d+)/u;

/** The major version a dependency range pins, or null when it names none. */
export const rangeMajor = (range: string): number | null => {
  const major = RANGE_MAJOR.exec(range)?.groups?.major;
  return major === undefined ? null : Number(major);
};

// Ranges whose version lives somewhere the bump doesn't rewrite: a pnpm
// catalog in pnpm-workspace.yaml, or the `range` of an `npm:name@range` alias.
const CATALOG_RANGE = /^catalog:(?<name>.*)$/u;
const NPM_ALIAS = /^npm:.+@(?<range>[^@]*)$/u;

/**
 * What to change by hand for a `blume` range the bump can't rewrite (a
 * `manual` {@link DependencyBump}): the pnpm catalog entry it points at, or
 * the version inside its `npm:` alias.
 */
export const manualBumpAdvice = (range: string, version: string): string => {
  const catalog = CATALOG_RANGE.exec(range)?.groups?.name;
  if (catalog === undefined) {
    return `package.json installs blume through the alias \`${range}\`, which \`blume upgrade\` doesn't rewrite: set the alias's version to ^${version}, then reinstall.`;
  }
  const entry =
    catalog === "" || catalog === "default"
      ? "`catalog`"
      : `\`catalogs.${catalog}\``;
  return `package.json takes blume from the pnpm catalog (\`${range}\`), which \`blume upgrade\` can't bump: set blume to ^${version} under ${entry} in pnpm-workspace.yaml if it isn't already, then reinstall.`;
};

// The file's own indentation (two spaces, four, or a tab), so a fallback
// rewrite doesn't reformat a package.json the user keeps differently.
const INDENT = /^(?<indent>[ \t]+)"/mu;

const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
const escapeRegExp = (value: string): string =>
  value.replaceAll(REGEXP_SPECIAL, String.raw`\$&`);

/**
 * `text` with the `blume` range under `field` replaced in place, so the file
 * keeps its own formatting, key order, and inline objects; null when the entry
 * isn't written the plain way (an escaped key or value).
 */
const replaceRange = (
  text: string,
  field: DependencyField,
  from: string,
  to: string
): string | null => {
  const value = JSON.stringify(from);
  const entry = new RegExp(`"blume"\\s*:\\s*${escapeRegExp(value)}`, "gu");
  entry.lastIndex = Math.max(text.indexOf(JSON.stringify(field)), 0);
  const match = entry.exec(text);
  if (!match) {
    return null;
  }
  const end = match.index + match[0].length;
  return `${text.slice(0, end - value.length)}${JSON.stringify(to)}${text.slice(end)}`;
};

/**
 * Point `package.json`'s `blume` dependency at `^version` when it pins an
 * older major. A range already on this major, or one that names no version
 * (`workspace:*`, `latest`), is reported as current and left alone; one whose
 * version lives elsewhere (`catalog:`, an `npm:` alias of an older major) is
 * `manual`, for the user to change; a project with no `package.json`, or none
 * that lists `blume`, is `missing`. Only the range changes: the rest of the
 * file is kept byte for byte.
 */
export const bumpBlumeDependency = async (
  root: string,
  version: string
): Promise<DependencyBump> => {
  const path = join(root, "package.json");
  if (!existsSync(path)) {
    return { status: "missing" };
  }
  const text = await readFile(path, "utf-8");
  // SAFETY: package.json is a JSON object; only its dependency maps, which
  // map package names to range strings, are read.
  const pkg = JSON.parse(text) as PackageJson;
  const field = DEPENDENCY_FIELDS.find(
    (name) => pkg[name]?.blume !== undefined
  );
  const from = field ? pkg[field]?.blume : undefined;
  if (!(field && from)) {
    return { status: "missing" };
  }
  if (CATALOG_RANGE.test(from)) {
    return { range: from, status: "manual" };
  }
  const aliased = NPM_ALIAS.exec(from)?.groups?.range;
  const current = rangeMajor(aliased ?? from);
  const target = rangeMajor(version);
  if (current === null || target === null || current >= target) {
    return { range: from, status: "current" };
  }
  if (aliased !== undefined) {
    return { range: from, status: "manual" };
  }
  const to = `^${version}`;
  const indent = INDENT.exec(text)?.groups?.indent ?? "  ";
  const updated = { ...pkg, [field]: { ...pkg[field], blume: to } };
  await writeFile(
    path,
    replaceRange(text, field, from, to) ??
      `${JSON.stringify(updated, null, indent)}\n`
  );
  return { field, from, status: "bumped", to };
};

/**
 * Whether `root` is no Blume project at all: no config file and no `blume`
 * dependency, so the upgrade would only check the defaults and report the
 * folder ready. A zero-config project still lists `blume`.
 */
export const isOutsideBlumeProject = (
  root: string,
  bump: DependencyBump
): boolean => bump.status === "missing" && findConfigFile(root) === null;

// ---------------------------------------------------------------------------
// Removed `blume build` flags
// ---------------------------------------------------------------------------

/** A `blume build` flag Blume 2 removed, bare or with an `=value`. */
const REMOVED_BUILD_FLAG = /^--(?<flag>adapter|base|output)(?:=|$)/u;

/** The removed `blume build` flags among `args`, in order, each once. */
export const removedBuildFlags = (args: readonly string[]): string[] => [
  ...new Set(
    args.flatMap((arg) => {
      const flag = REMOVED_BUILD_FLAG.exec(arg)?.groups?.flag;
      return flag ? [flag] : [];
    })
  ),
];

/** The flags as the reader typed them: `--adapter, --output`. */
export const flagList = (flags: string[]): string =>
  flags.map((flag) => `--${flag}`).join(", ");

/** What replaces each removed flag: the `deployment` config. */
export const removedBuildFlagsAdvice = (flags: string[]): string => {
  const advice: string[] = [];
  if (flags.includes("adapter") || flags.includes("output")) {
    advice.push(
      'name the host in blume.config.ts with `deployment: vercel()` (or `netlify()`, `cloudflare()`, `node()`) from "blume/deploy" — a host adapter builds for the server, and `output: "static"` keeps it static'
    );
  }
  if (flags.includes("base")) {
    advice.push(
      'set the subpath with `deployment: { base: "/docs" }`, or the host adapter\'s `base` option'
    );
  }
  return `Drop ${flagList(flags)} and ${advice.join("; ")}.`;
};

// A command that runs the Blume CLI: the bare bin, a versioned package
// (`blume@2`), or a path to it (`./node_modules/.bin/blume`).
const BLUME_BIN = /(?:^|[/\\])blume(?:@\S+)?$/u;
const COMMAND_SEPARATOR = /&&|\|\||[;|]/u;
const WHITESPACE = /\s+/u;

/** The arguments each `blume build` in a script passes, flattened. */
const buildArgs = (script: string): string[] =>
  script.split(COMMAND_SEPARATOR).flatMap((command) => {
    const words = command.trim().split(WHITESPACE);
    const at = words.findIndex(
      (word, index) => BLUME_BIN.test(word) && words[index + 1] === "build"
    );
    return at === -1 ? [] : words.slice(at + 2);
  });

/** The slice of package.json the script check reads. */
const scriptsSchema = z.looseObject({
  scripts: z.record(z.string(), z.string()).default({}),
});

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/**
 * A finding for each package.json script that still passes a removed flag to
 * `blume build` — it would otherwise build a static site without a word.
 */
const scriptFindings = async (root: string): Promise<Diagnostic[]> => {
  const path = join(root, "package.json");
  if (!existsSync(path)) {
    return [];
  }
  const text = await readFile(path, "utf-8");
  const pkg = scriptsSchema.safeParse(JSON.parse(text));
  const scripts = pkg.success ? pkg.data.scripts : {};
  const scriptsAt = text.indexOf('"scripts"');
  return Object.entries(scripts).flatMap(([name, script]) => {
    const flags = removedBuildFlags(buildArgs(script));
    if (flags.length === 0) {
      return [];
    }
    const at = text.indexOf(JSON.stringify(name), scriptsAt);
    return [
      {
        code: "BLUME_BUILD_FLAG_REMOVED",
        file: path,
        line: at === -1 ? undefined : lineOf(text, at),
        message: `The "${name}" script passes ${flagList(flags)} to \`blume build\`, which Blume 2 removed.`,
        severity: "error",
        suggestion: removedBuildFlagsAdvice(flags),
      } satisfies Diagnostic,
    ];
  });
};

/**
 * Run one check, turning the {@link BlumeError} it throws into its findings:
 * each config issue or `components.ts` entry on its own, or the one diagnostic
 * any other check has.
 */
const findingsOf = async (
  check: () => Promise<void>
): Promise<Diagnostic[]> => {
  try {
    await check();
    return [];
  } catch (error) {
    if (
      error instanceof ConfigValidationError ||
      error instanceof ComponentOverridesError
    ) {
      return error.issues;
    }
    if (error instanceof BlumeError) {
      return [error.diagnostic];
    }
    throw error;
  }
};

/**
 * Check a project against this version of Blume: its config through the
 * loader (every invalid field, each with its line and replacement), its
 * `components.ts` through the static override planner (each entry at its
 * line), and its package.json scripts for `blume build` flags that no longer
 * exist. Returns the failures;
 * an empty list means the project is ready.
 */
export const collectUpgradeFindings = async (
  root: string
): Promise<Diagnostic[]> => {
  const componentsFile = findComponentsFile(root);
  return [
    ...(await findingsOf(async () => {
      await loadConfig(root);
    })),
    ...(componentsFile
      ? await findingsOf(async () => {
          analyzeComponentOverrides(
            await readFile(componentsFile, "utf-8"),
            componentsFile
          );
        })
      : []),
    ...(await scriptFindings(root)),
  ];
};

/** A finding as plain text for the agent: where, what, and the fix. */
const plainFinding = (finding: Diagnostic, root: string): string => {
  const where = finding.file
    ? `${relative(root, finding.file)}${finding.line === undefined ? "" : `:${finding.line}`}`
    : "blume.config.ts";
  const fix = finding.suggestion ? `\n  Fix: ${finding.suggestion}` : "";
  return `- ${where} (${finding.code})\n  ${finding.message.replaceAll("\n", "\n  ")}${fix}`;
};

/**
 * The handoff prompt: the findings inline (they're few, and each already
 * names its replacement), where the guide is, and the ground rules — change
 * the config's shape, never the site's behavior, and verify with the site's
 * own checks, run through the project's package runner (`npx`, `pnpm exec`),
 * since a local install puts no `blume` on PATH.
 */
export const upgradePrompt = (options: {
  findings: Diagnostic[];
  guidePath: string;
  root: string;
  runner: string;
  version: string;
}): string =>
  `Upgrade this Blume project to Blume ${options.version}. \`blume upgrade\` has bumped the \`blume\` dependency in package.json where it could; what's left is the config.

The upgrade guide is at ${options.guidePath} (online at ${UPGRADE_GUIDE_URL}). It covers every change between Blume 1 and 2 with before-and-after examples: search, deployment, content sources, API references, analytics, and the assistant's model provider become adapters imported from \`blume/*\` subpaths; the machine-readable settings move from \`ai\` to \`agents\`; Ask AI is renamed the assistant, so \`ai.ask\` becomes \`ai.assistant\`; and \`components.ts\` entries must be one of the static forms.

\`blume upgrade\` found:

${options.findings.map((finding) => plainFinding(finding, options.root)).join("\n\n")}

Work through every finding:
1. Read the guide section for each change before editing.
2. Rewrite the config to the Blume 2 form, adding the adapter imports it needs. Keep the site's behavior the same: the same content, routes, search backend, deployment target, analytics, and credentials (keep reading secrets from the same environment variables).
3. The config loader reports every invalid field at once, but some changes only surface once earlier ones are fixed, so rerun \`${options.runner} blume doctor\` after each round of edits.
4. Never delete content, or remove a setting only to silence an error; if something needs a human decision, leave it and say so in your summary.

When \`${options.runner} blume doctor\` reports no errors, run \`${options.runner} blume build\` and fix anything it reports until it succeeds.`;
