import { existsSync } from "node:fs";
import { cp, readdir, readFile, rm } from "node:fs/promises";

import { join, relative } from "pathe";

import { mountBasePath, stripBasePath } from "./base-path.ts";
import { nextFenceState } from "./code-fences.ts";
import type { FenceState } from "./code-fences.ts";
import { writeTextAtomic } from "./fs-atomic.ts";
import { localizeRoute } from "./i18n.ts";
import type { BlumeProject } from "./project-graph.ts";
import { isWithin, scanProject } from "./project-graph.ts";
import { VERSION_ID } from "./schema.ts";
import type { Diagnostic } from "./types.ts";
import { VERSION_LIKE, versionizeRoute } from "./versions.ts";

/** What `cutVersion` did, for the CLI to report. */
export interface CutResult {
  /** Files copied into the snapshot. */
  copied: number;
  /** Markdown pages whose root-absolute links were rewritten, with counts. */
  rewritten: { file: string; count: number }[];
  /** Whether `blume.config.ts` was updated in place. */
  configUpdated: boolean;
  /**
   * Whether that update added the whole `versions` block — the first cut of a
   * project that had no versioning — rather than one `archived` entry.
   */
  versionsAdded: boolean;
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
// A root-absolute markdown link/image target, reference-style link definition
// (`[setup]: /guides/setup`, up to three spaces in, never a `[^note]:`
// footnote), or HTML href/src attribute in either quote style. Named groups
// carry the prefix (kept) and target (rewritten).
const ROOT_LINK =
  /(?<prefix>\]\(|^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*<?|(?:href|src)=["'])(?<target>\/[^\s"'<>)]*)/gu;

/**
 * Build the link-rewrite table: every current-version route (basePath
 * stripped, since authors write root-absolute links as if mounted at root;
 * a link that spells the base out is looked up without it, see
 * `snapshotTarget`) mapped to the same page's route inside the new snapshot.
 * Only pages the snapshot actually contains qualify — filesystem pages under
 * the content root. Spec-rendered references (`/api`, `/events`) and remote
 * sources aren't copied, so links to them keep pointing at the live pages
 * instead of a 404 inside the snapshot.
 */
const buildRouteRewrites = (
  project: BlumeProject,
  id: string
): Map<string, string> => {
  const { basePath, i18n } = project.config;
  const { contentRoot } = project.context;
  const rewrites = new Map<string, string>();
  // Under i18n, authors write links in the unprefixed form (`/guides/setup`)
  // and rendering moves them into the reader's locale — a form no page is
  // routed at when the default locale keeps its prefix
  // (`hideDefaultLocalePrefix: false`). So it is mapped too, to the
  // unprefixed snapshot route, which rendering localizes the same way. Page
  // routes win where the two forms coincide.
  const logical = new Map<string, string>();
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
    const snapshot = versionizeRoute(page.versionKey, id);
    rewrites.set(
      stripBasePath(basePath, page.route),
      i18n ? localizeRoute(snapshot, page.locale, i18n) : snapshot
    );
    if (i18n) {
      logical.set(page.versionKey, snapshot);
    }
  }
  for (const [route, snapshot] of logical) {
    if (!rewrites.has(route)) {
      rewrites.set(route, snapshot);
    }
  }
  return rewrites;
};

/**
 * The snapshot link a root-absolute path rewrites to, or undefined when the
 * snapshot has no copy of its page. A path written with the base path by hand
 * (`/docs/guides/x` under `basePath: "/docs"`) names the same page as
 * `/guides/x` — rendering leaves an already-based link alone (see
 * `withBasePath`) — so it is looked up without the base and keeps it.
 */
const snapshotTarget = (
  path: string,
  rewrites: Map<string, string>,
  basePath: string
): string | undefined => {
  const based =
    basePath !== "" && (path === basePath || path.startsWith(`${basePath}/`));
  if (!based) {
    return rewrites.get(path);
  }
  const replacement = rewrites.get(stripBasePath(basePath, path));
  return replacement === undefined
    ? undefined
    : mountBasePath(basePath, replacement);
};

/** Rewrite one line's root-absolute internal links via the rewrite table. */
const rewriteLine = (
  line: string,
  rewrites: Map<string, string>,
  basePath: string
): string => {
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
    const replacement = snapshotTarget(bare, rewrites, basePath);
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
 * `basePath` is the site's, for links that spell it out by hand.
 */
export const rewriteSnapshotLinks = (
  source: string,
  rewrites: Map<string, string>,
  basePath = ""
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
    const rewrittenLine = rewriteLine(line, rewrites, basePath);
    if (rewrittenLine !== line) {
      count += 1;
    }
    return rewrittenLine;
  });
  return { count, text: lines.join("\n") };
};

/**
 * The switcher label a first cut gives the live docs. `versions.current.label`
 * is required, and "Latest" reads right until the author names the release.
 */
const CURRENT_LABEL = "Latest";

/** The config entry to add, as a paste-ready snippet for the fallback path. */
const snippetFor = (id: string, hasVersions: boolean): string =>
  hasVersions
    ? `Add to versions.archived in blume.config.ts (newest first):\n\n  { id: "${id}" },\n`
    : `Add to blume.config.ts:\n\n  versions: {\n    archived: [{ id: "${id}" }],\n    current: { label: "${CURRENT_LABEL}" },\n  },\n`;

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
  // an inline entry, a multiline array gets its own indented line — on the
  // file's own line ending, so a CRLF config doesn't gain a lone LF.
  const eol = /^\r?\n/u.exec(rest)?.[0];
  let entry: string;
  if (rest.trimStart().startsWith("]")) {
    entry = `{ id: "${id}" }`;
  } else if (eol) {
    entry = `${eol}${indent}  { id: "${id}" },`;
  } else {
    entry = `{ id: "${id}" }, `;
  }
  await writeTextAtomic(configPath, text.slice(0, insertAt) + entry + rest);
  return true;
};

/** The opening brace of the config object: `defineConfig({` or `export default {`. */
const CONFIG_OBJECT = /(?:defineConfig\(\s*|export\s+default\s+)\{/gu;

/**
 * Best-effort in-place registration of a first version: add a `versions` block
 * (the id archived, the live docs labeled {@link CURRENT_LABEL}) as the first
 * property of the config object. Only the plain shape is edited — exactly one
 * `defineConfig({` or `export default {` and no `versions` key yet — so a
 * config built any other way falls back to the printed snippet rather than
 * risk corrupting it.
 */
export const insertVersionsBlock = async (
  configPath: string,
  id: string
): Promise<boolean> => {
  let text: string;
  try {
    text = await readFile(configPath, "utf-8");
  } catch {
    return false;
  }
  const matches = [...text.matchAll(CONFIG_OBJECT)];
  const [match] = matches;
  if (matches.length !== 1 || !match || /\bversions\s*:/u.test(text)) {
    return false;
  }
  const insertAt = match.index + match[0].length;
  const rest = text.slice(insertAt);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = text.lastIndexOf("\n", match.index) + 1;
  const outer = /^[ \t]*/u.exec(text.slice(lineStart))?.[0] ?? "";
  // Match the indentation of the property on the next line, when there is one.
  const indent =
    /^[ \t]*\r?\n(?<indent>[ \t]*)\S/u.exec(rest)?.groups?.indent ??
    `${outer}  `;
  const block = [
    "versions: {",
    `  archived: [{ id: "${id}" }],`,
    `  current: { label: "${CURRENT_LABEL}" },`,
    "},",
  ]
    .map((line) => `${indent}${line}`)
    .join(eol);
  const body = rest.trimStart();
  let tail: string;
  if (body.startsWith("}")) {
    // An empty object: close it on its own line.
    tail = `${eol}${outer}${body}`;
  } else if (/^[ \t]*\r?\n/u.test(rest)) {
    tail = rest;
  } else {
    // An inline object: move its first property onto the next line.
    tail = `${eol}${indent}${body}`;
  }
  await writeTextAtomic(
    configPath,
    `${text.slice(0, insertAt)}${eol}${block}${tail}`
  );
  return true;
};

/**
 * Version-shaped folders (`v1.0/`) at the top of the content root of a project
 * with no `versions` config — usually a snapshot `blume version` cut but
 * couldn't register — which build as ordinary content at `/v1.0/…`, so every
 * page ships twice. With versioning configured, the scan's own
 * `BLUME_VERSIONS_UNCONFIGURED_VERSION` covers a folder it doesn't list; this
 * check is `blume doctor`'s alone, since an unversioned site can have a real
 * `v1/` section that a warning on every build would only nag about.
 */
export const unregisteredSnapshotDiagnostics = (
  project: BlumeProject
): Diagnostic[] => {
  if (project.config.versions) {
    return [];
  }
  const { contentRoot } = project.context;
  const folders = new Set<string>();
  for (const page of project.graph.pages) {
    const [first, ...rest] = page.sourcePath
      ? relative(contentRoot, page.sourcePath).split("/")
      : [];
    if (first && rest.length > 0 && VERSION_LIKE.test(first)) {
      folders.add(first);
    }
  }
  return [...folders].toSorted().map((folder) => ({
    code: "BLUME_VERSIONS_UNCONFIGURED_VERSION",
    file: join(contentRoot, folder),
    message: `Folder "${folder}/" looks like a version snapshot, but versioning isn't configured, so its pages build as ordinary content at /${folder}/….`,
    severity: "warning",
    suggestion: `If it's a snapshot, register it with \`versions: { archived: [{ id: "${folder}" }], current: { label: "${CURRENT_LABEL}" } }\` in blume.config.ts; if it's an ordinary section, ignore this.`,
  }));
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
        const { text, count } = rewriteSnapshotLinks(
          source,
          rewrites,
          project.config.basePath
        );
        if (count > 0) {
          await writeTextAtomic(abs, text);
          rewritten.push({ count, file: relative(dir, abs) });
        }
      })
    );
  };
  await walk(dir);

  const configPath =
    project.context.configFile ?? join(root, "blume.config.ts");
  const firstVersion = project.config.versions === undefined;
  const configUpdated = firstVersion
    ? await insertVersionsBlock(configPath, id)
    : await insertArchivedVersion(configPath, id);

  return {
    configSnippet: configUpdated ? null : snippetFor(id, !firstVersion),
    configUpdated,
    copied,
    dir,
    rewritten,
    versionsAdded: configUpdated && firstVersion,
  };
};
