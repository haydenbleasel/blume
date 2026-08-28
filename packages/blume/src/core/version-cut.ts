import { existsSync } from "node:fs";
import { cp, readdir, readFile, rm } from "node:fs/promises";

import { join, relative } from "pathe";

import { stripBasePath } from "./base-path.ts";
import { writeTextAtomic } from "./fs-atomic.ts";
import { localizeRoute } from "./i18n.ts";
import type { BlumeProject } from "./project-graph.ts";
import { isWithin, scanProject } from "./project-graph.ts";
import { VERSION_ID } from "./schema.ts";
import { nextFenceState } from "./sources/normalize.ts";
import type { FenceState } from "./sources/normalize.ts";
import { VERSION_LIKE, versionizeRoute } from "./versions.ts";

/** What `cutVersion` did, for the CLI to report. */
export interface CutResult {
  /** Files copied into the snapshot. */
  copied: number;
  /** Markdown pages whose root-absolute links were rewritten, with counts. */
  rewritten: { file: string; count: number }[];
  /** Whether `blume.config.ts` was updated in place. */
  configUpdated: boolean;
  /** Ready-to-paste config snippet when in-place update was not possible. */
  configSnippet: string | null;
  /** Absolute path of the created snapshot directory. */
  dir: string;
}

/** A `cutVersion` failure the CLI reports as a user error, not a crash. */
export class CutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutError";
  }
}

// Inline code spans are syntax being *shown*, not links — blank them before
// matching so replacements can splice into the real line by index (the mask
// preserves length). Mirrors the content-assets rewriter.
const INLINE_CODE = /`[^`]*`/gu;
// A markdown link/image target or an HTML href/src attribute whose value is
// root-absolute. Named groups carry the prefix (kept) and target (rewritten).
const ROOT_LINK = /(?<prefix>\]\(|href="|src=")(?<target>\/[^\s"')]*)/gu;

/**
 * Build the link-rewrite table: every current-version route (basePath
 * stripped, since authors write root-absolute links as if mounted at root)
 * mapped to the same page's route inside the new snapshot. Only pages the
 * snapshot actually contains qualify — filesystem pages under the content
 * root. Spec-rendered references (`/api`, `/events`) and remote sources
 * aren't copied, so links to them keep pointing at the live pages instead of
 * a 404 inside the snapshot.
 */
const buildRouteRewrites = (
  project: BlumeProject,
  id: string
): Map<string, string> => {
  const { basePath, i18n } = project.config;
  const { contentRoot } = project.context;
  const rewrites = new Map<string, string>();
  for (const page of project.graph.pages) {
    // `sourcePath` marks a page backed by a local file, which excludes
    // generated and remote pages; the content-root check below excludes local
    // files that live outside the tree a version snapshot copies. A staged
    // page (an Obsidian note) is served from its source, not from the copied
    // tree, so it keeps publishing as current even when its file sits under
    // the content root.
    const { sourcePath } = page;
    if (
      page.version !== "" ||
      page.collection === "staged" ||
      !sourcePath ||
      relative(contentRoot, sourcePath).startsWith("..")
    ) {
      continue;
    }
    const logical = versionizeRoute(page.versionKey, id);
    rewrites.set(
      stripBasePath(basePath, page.route),
      i18n ? localizeRoute(logical, page.locale, i18n) : logical
    );
  }
  return rewrites;
};

/** Rewrite one line's root-absolute internal links via the rewrite table. */
const rewriteLine = (line: string, rewrites: Map<string, string>): string => {
  const masked = line.replaceAll(INLINE_CODE, (span) =>
    " ".repeat(span.length)
  );
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const match of masked.matchAll(ROOT_LINK)) {
    const target = match.groups?.target ?? "";
    // An anchor or query stays attached to the rewritten path.
    const hash = target.search(/[#?]/u);
    const path = hash === -1 ? target : target.slice(0, hash);
    const suffix = hash === -1 ? "" : target.slice(hash);
    const bare = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
    const replacement = rewrites.get(bare);
    if (replacement === undefined) {
      continue;
    }
    const offset = (match.index ?? 0) + (match.groups?.prefix?.length ?? 0);
    out += line.slice(cursor, offset) + replacement + suffix;
    cursor = offset + target.length;
    count += 1;
  }
  return count === 0 ? line : out + line.slice(cursor);
};

/** A page's link-rewritten text and how many of its lines changed. */
export interface SnapshotRewrite {
  text: string;
  count: number;
}

/**
 * Rewrite a copied page's root-absolute internal links to their snapshot
 * equivalents, skipping fenced and inline code. Relative links need no
 * rewriting — the whole tree copies together, so they stay self-contained.
 */
export const rewriteSnapshotLinks = (
  source: string,
  rewrites: Map<string, string>
): SnapshotRewrite => {
  let fence: FenceState = null;
  let count = 0;
  const lines = source.split("\n").map((line) => {
    const next = nextFenceState(line, fence);
    const inFence = fence !== null || next !== null;
    fence = next;
    if (inFence) {
      return line;
    }
    const rewrittenLine = rewriteLine(line, rewrites);
    if (rewrittenLine !== line) {
      count += 1;
    }
    return rewrittenLine;
  });
  return { count, text: lines.join("\n") };
};

/** The config entry to add, as a paste-ready snippet for the fallback path. */
const snippetFor = (id: string, hasVersions: boolean): string =>
  hasVersions
    ? `Add to versions.archived in blume.config.ts (newest first):\n\n  { id: "${id}" },\n`
    : `Add to blume.config.ts:\n\n  versions: {\n    archived: [{ id: "${id}" }],\n    current: { label: "…" },\n  },\n`;

/**
 * Best-effort in-place config update: insert the new id at the head of an
 * existing \`archived: [\` array literal, preserving indentation. Anything
 * fancier (computed arrays, config spread across files) falls back to a
 * printed snippet — the config is user-authored TypeScript, and string-level
 * surgery beyond this simple shape risks corrupting it.
 */
export const insertArchivedVersion = async (
  configPath: string,
  id: string
): Promise<boolean> => {
  let text: string;
  try {
    text = await readFile(configPath, "utf-8");
  } catch {
    return false;
  }
  const match = text.match(/(?<lead>archived:\s*\[)/u);
  if (!match || match.index === undefined) {
    return false;
  }
  const insertAt = match.index + (match.groups?.lead?.length ?? 0);
  // Indentation: one level deeper than the line holding `archived:`.
  const lineStart = text.lastIndexOf("\n", match.index) + 1;
  const indent = text.slice(lineStart).match(/^\s*/u)?.[0] ?? "";
  const rest = text.slice(insertAt);
  // Match the array's authored shape: empty stays bare, an inline array gets
  // an inline entry, a multiline array gets its own indented line.
  let entry: string;
  if (rest.trimStart().startsWith("]")) {
    entry = `{ id: "${id}" }`;
  } else if (rest.startsWith("\n")) {
    entry = `\n${indent}  { id: "${id}" },`;
  } else {
    entry = `{ id: "${id}" }, `;
  }
  await writeTextAtomic(configPath, text.slice(0, insertAt) + entry + rest);
  return true;
};

/**
 * Freeze the current docs as an archived version: copy the content tree into
 * `<contentRoot>/<id>/` (excluding existing snapshots), rewrite root-absolute
 * internal links so the copy is self-contained, and register the id in
 * `blume.config.ts` (or print the snippet to paste).
 */
export const cutVersion = async (
  root: string,
  id: string,
  options: { force?: boolean } = {}
): Promise<CutResult> => {
  if (!VERSION_ID.test(id)) {
    throw new CutError(
      `Version ids must start with a letter (e.g. "v1.0") and contain only letters, digits, dots, hyphens, and underscores — got "${id}".`
    );
  }

  const project = await scanProject(root);
  const errors = project.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  );
  if (errors.length > 0) {
    throw new CutError(
      `The project has ${errors.length} error diagnostic(s) — fix them before cutting a version (run \`blume validate\`).`
    );
  }
  // A missing content root already fails inside `scanProject` (the filesystem
  // source's own validation), so only the version-level checks remain here.
  const { contentRoot } = project.context;
  if (project.config.versions?.archived.some((version) => version.id === id)) {
    throw new CutError(
      `Version "${id}" is already registered in versions.archived.`
    );
  }

  const dir = join(contentRoot, id);
  if (existsSync(dir)) {
    if (!options.force) {
      throw new CutError(
        `${dir} already exists — pass --force to overwrite the snapshot.`
      );
    }
    await rm(dir, { force: true, recursive: true });
  }

  // Existing snapshots must not nest inside the new one: configured ids, plus
  // any version-shaped directory (`v1.0/`) that never made it into the config —
  // e.g. a prior cut whose config update fell back to a printed snippet. A
  // genuine content folder that merely looks like a version already draws the
  // rename-or-register diagnostic, so skipping it here is consistent.
  const excluded = new Set([
    id,
    "node_modules",
    ...(project.config.versions?.archived.map((version) => version.id) ?? []),
  ]);
  // Another local source's tree under the content root — an Obsidian vault the
  // filesystem source excludes — is that source's to publish. Copying it would
  // republish its raw notes (wikilinks and `%%comments%%` intact) as
  // filesystem pages of the snapshot, while the source itself keeps serving
  // them as current.
  const foreignRoots = project.sources
    .flatMap((source) =>
      source.staged && source.contentRoot ? [source.contentRoot] : []
    )
    .filter((tree) => isWithin(contentRoot, tree));
  const isForeign = (path: string): boolean =>
    foreignRoots.some((tree) => isWithin(tree, path));
  const entries = await readdir(contentRoot, { withFileTypes: true });
  let copied = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (
        excluded.has(entry.name) ||
        entry.name.startsWith(".") ||
        (entry.isDirectory() && VERSION_LIKE.test(entry.name))
      ) {
        return;
      }
      await cp(join(contentRoot, entry.name), join(dir, entry.name), {
        filter: (source) => !isForeign(source),
        recursive: true,
      });
    })
  );

  // Rewrite root-absolute internal links in every copied markdown page.
  const rewrites = buildRouteRewrites(project, id);
  const rewritten: { file: string; count: number }[] = [];
  const walk = async (current: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });
    await Promise.all(
      children.map(async (child) => {
        const abs = join(current, child.name);
        if (child.isDirectory()) {
          await walk(abs);
          return;
        }
        copied += 1;
        if (!/\.mdx?$/u.test(child.name)) {
          return;
        }
        const source = await readFile(abs, "utf-8");
        const { text, count } = rewriteSnapshotLinks(source, rewrites);
        if (count > 0) {
          await writeTextAtomic(abs, text);
          rewritten.push({ count, file: relative(dir, abs) });
        }
      })
    );
  };
  await walk(dir);

  const configPath = join(root, "blume.config.ts");
  const configUpdated =
    project.config.versions !== undefined &&
    (await insertArchivedVersion(configPath, id));

  return {
    configSnippet: configUpdated
      ? null
      : snippetFor(id, project.config.versions !== undefined),
    configUpdated,
    copied,
    dir,
    rewritten,
  };
};
