import { existsSync, watch as fsWatch, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

import { basename, join, relative, resolve } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import type { Diagnostic } from "../types.ts";
import { hashText } from "./cache.ts";
import type { FenceState } from "./normalize.ts";
import {
  extractHeadings,
  mapRoute,
  nextFenceState,
  slugifyPath,
  withPrefix,
} from "./normalize.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";
import { BLUME_WATCH_IGNORE_DIRS, ignoringWatchListener } from "./watch.ts";

/** Options for the built-in Obsidian vault source. */
export interface ObsidianSourceOptions {
  /** Vault folder names to skip at any depth, in addition to dot-folders. */
  exclude?: string[];
  /** Stable source name; namespaces ids and diagnostics. */
  name: string;
  /** Namespaces the source's routes under `/<prefix>/`; e.g. `vault`. */
  prefix?: string;
  /** Vault directory, absolute or relative to `projectRoot`. */
  vault: string;
}

const MARKDOWN_FILE = /\.md$/iu;
/** `%%comment%%` on a single line; multi-line comments are not stripped yet. */
const OBSIDIAN_COMMENT = /%%.*?%%/gu;
/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]`. */
const WIKILINK =
  /(?<embed>!)?\[\[(?<target>[^\]|#\n]*)(?:#(?<heading>[^\]|\n]+))?(?:\|(?<alias>[^\]\n]+))?\]\]/gu;
/** Obsidian's own metadata dir; never content, and rewritten as you edit. */
const OBSIDIAN_CONFIG_DIR = ".obsidian";

/** A vault note, read and split into frontmatter and body. */
interface ParsedNote {
  absPath: string;
  /** The note body, frontmatter stripped and otherwise untouched. */
  content: string;
  data: SourceEntry["data"];
  /** Vault-relative path, e.g. `guides/Getting Started.md`. */
  rel: string;
}

/**
 * The key a note name or heading is indexed and looked up under. macOS writes
 * filenames as NFD and editors type NFC, so both sides normalize before
 * casefolding.
 */
const indexKey = (value: string): string =>
  value.normalize("NFC").toLowerCase();

/** Leading and trailing slashes, which name no route segment. */
const EDGE_SLASHES = /^\/+|\/+$/gu;

/** Whether a raw frontmatter value is a string (the `title`/`slug` overrides). */
const isStringValue = (value: SourceEntry["data"][string]): value is string =>
  typeof value === "string";

/**
 * A note's route input: its vault-relative path, slugged. Vault filenames are
 * prose (`Getting Started.md`) and `mapRoute` does not slug, so this does —
 * through {@link slugifyPath}, which keeps a non-Latin name routable.
 */
const entrySlugFor = (rel: string): string =>
  slugifyPath(rel.replace(MARKDOWN_FILE, ""));

/**
 * The route a note publishes at, prefix included — the href a `[[Wikilink]]` to
 * it must produce. Mirrors `normalizeEntry`'s precedence and prefixing so the
 * two cannot disagree.
 */
const routeFor = (note: ParsedNote, prefix: string | undefined): string => {
  const slugInput = isStringValue(note.data.slug)
    ? note.data.slug
    : entrySlugFor(note.rel);
  // `normalizeEntry` trims the slug's edge slashes and falls back to the ref
  // when nothing survives; a `slug: "/"` must route by path in both places.
  const slug = slugInput.replaceAll(EDGE_SLASHES, "");
  const routeInput = slug ? `${slug}.md` : note.rel;
  return mapRoute(withPrefix(prefix, routeInput)).route;
};

/** One note as the wikilink index knows it: where it routes, and its anchors. */
interface IndexedNote {
  /** Anchor id per heading, keyed by {@link indexKey}. */
  anchors: Map<string, string>;
  /** The note's route, prefix included. */
  href: string;
}

/** Dead or ambiguous wikilink targets, accumulated across one load. */
interface UnresolvedTargets {
  /** Note names claimed by more than one file, with the files that claim them. */
  ambiguous: string[];
  /** `Note#Heading` targets whose note exists but whose heading does not. */
  anchors: string[];
  /** Targets that matched no note in the vault. */
  notes: string[];
}

/** A note paired with its own index entry, so a rewrite can address itself. */
interface IndexedPair {
  note: ParsedNote;
  self: IndexedNote;
}

/** The wikilink lookup table, plus each note's own entry in it. */
interface NoteIndex {
  index: Map<string, IndexedNote>;
  pairs: IndexedPair[];
}

/** A fresh accumulator for a pass whose findings are not reported. */
const noTargets = (): UnresolvedTargets => ({
  ambiguous: [],
  anchors: [],
  notes: [],
});

/**
 * Heading text to the anchor id the renderer will emit, via the same
 * {@link extractHeadings} the manifest uses. Reads the rendered body, not the
 * authored one, so a heading Blume rewrote is indexed by what ships.
 */
const anchorsOf = (body: string): Map<string, string> => {
  const anchors = new Map<string, string>();
  for (const heading of extractHeadings(body)) {
    const key = indexKey(heading.text);
    // Obsidian points a repeated-heading link at the first match; the slugger
    // has already disambiguated the later ones (`setup-1`).
    if (!anchors.has(key)) {
      anchors.set(key, heading.slug);
    }
  }
  return anchors;
};

/** Group notes by the bare name a `[[Wikilink]]` can address them with. */
const byNoteName = (notes: ParsedNote[]): Map<string, ParsedNote[]> => {
  const grouped = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    const name = indexKey(basename(note.rel).replace(MARKDOWN_FILE, ""));
    const claimed = grouped.get(name);
    if (claimed) {
      claimed.push(note);
    } else {
      grouped.set(name, [note]);
    }
  }
  return grouped;
};

/**
 * Obsidian addresses `[[Name]]` by note name, not by path; index each note under
 * its basename and under its full vault-relative path. A basename two notes
 * share resolves to the first in vault order and is reported — Obsidian
 * disambiguates by the linking note's location, which a rewrite cannot know.
 */
const buildNoteIndex = (
  notes: ParsedNote[],
  prefix: string | undefined,
  unresolved: UnresolvedTargets,
  bodyOf: (note: ParsedNote) => string
): NoteIndex => {
  const index = new Map<string, IndexedNote>();
  // Memoized: the name loop and the path loop below both index most notes, and
  // `anchorsOf` re-scans the whole body each time.
  const entries = new Map<string, IndexedNote>();
  const indexed = (note: ParsedNote): IndexedNote => {
    const cached = entries.get(note.rel);
    if (cached) {
      return cached;
    }
    const built: IndexedNote = {
      anchors: anchorsOf(bodyOf(note)),
      href: routeFor(note, prefix),
    };
    entries.set(note.rel, built);
    return built;
  };
  for (const [name, claimants] of byNoteName(notes)) {
    const [first, ...rest] = claimants;
    if (first === undefined) {
      continue;
    }
    if (rest.length > 0) {
      unresolved.ambiguous.push(
        `${name} (${claimants.map((note) => note.rel).join(", ")})`
      );
    }
    index.set(name, indexed(first));
  }
  const pairs = notes.map((note) => {
    const self = indexed(note);
    index.set(indexKey(note.rel.replace(MARKDOWN_FILE, "")), self);
    return { note, self };
  });
  return { index, pairs };
};

/** Every run of backticks on a line — the only delimiter a code span has. */
const BACKTICK_RUN = /`+/gu;

/** One piece of a line: literal code, or prose open to rewriting. */
interface LineChunk {
  code: boolean;
  text: string;
}

/** The index of the next backtick run of exactly `length`, or -1. */
const closerAfter = (
  runs: RegExpExecArray[],
  from: number,
  length: number
): number => {
  for (let i = from; i < runs.length; i += 1) {
    if (runs[i]?.[0].length === length) {
      return i;
    }
  }
  return -1;
};

/**
 * Split prose into code and rewritable chunks. A run of N backticks opens a
 * span only if a run of exactly N follows — one regex expresses neither the
 * length match nor that condition. The scan runs over a whole run of prose
 * rather than a line, because a span may hold newlines while a run with no
 * closer is literal text.
 */
const splitCodeSpans = (text: string): LineChunk[] => {
  const runs = [...text.matchAll(BACKTICK_RUN)];
  const chunks: LineChunk[] = [];
  let cursor = 0;
  let i = 0;
  while (i < runs.length) {
    const length = runs[i]?.[0].length ?? 0;
    const at = runs[i]?.index ?? 0;
    const close = closerAfter(runs, i + 1, length);
    if (close === -1) {
      i += 1;
      continue;
    }
    const end = (runs[close]?.index ?? 0) + length;
    chunks.push(
      { code: false, text: text.slice(cursor, at) },
      { code: true, text: text.slice(at, end) }
    );
    cursor = end;
    i = close + 1;
  }
  chunks.push({ code: false, text: text.slice(cursor) });
  return chunks;
};

/** Rewrite one chunk's wikilinks and strip single-line comments. */
const transformChunk = (
  chunk: string,
  index: Map<string, IndexedNote>,
  self: IndexedNote,
  unresolved: UnresolvedTargets
): string =>
  chunk.replaceAll(OBSIDIAN_COMMENT, "").replaceAll(WIKILINK, (...args) => {
    // SAFETY: `String.replaceAll` passes the groups object last whenever the
    // pattern has named groups, and WIKILINK has four.
    const groups = args.at(-1) as Record<string, string | undefined>;
    const target = (groups.target ?? "").trim();
    const heading = groups.heading?.trim();
    const label = groups.alias?.trim() || heading || target;
    // Rewriting an embed means serving the attachment, which this source
    // does not do yet.
    if (groups.embed) {
      // SAFETY: the replacer's first argument is always the matched substring.
      return args[0] as string;
    }
    // `[[#Heading]]` addresses the note it sits in; an empty target with no
    // heading is not a link at all.
    if (target === "") {
      if (heading === undefined) {
        // SAFETY: the replacer's first argument is always the matched substring.
        return args[0] as string;
      }
      const own = self.anchors.get(indexKey(heading));
      if (own === undefined) {
        unresolved.anchors.push(`#${heading}`);
        return label;
      }
      return `[${label}](${self.href}#${own})`;
    }
    const note = index.get(indexKey(target));
    if (note === undefined) {
      unresolved.notes.push(target);
      return label;
    }
    if (heading === undefined) {
      return `[${label}](${note.href})`;
    }
    const anchor = note.anchors.get(indexKey(heading));
    if (anchor === undefined) {
      // The note is real, so keep the link and drop only the anchor — landing
      // on the page beats degrading the whole link to plain text.
      unresolved.anchors.push(`${target}#${heading}`);
      return `[${label}](${note.href})`;
    }
    return `[${label}](${note.href}#${anchor})`;
  });

/** Rewrite a line, leaving inline code spans (`` `[[x]]` ``) verbatim. */
const transformProse = (
  text: string,
  index: Map<string, IndexedNote>,
  self: IndexedNote,
  unresolved: UnresolvedTargets
): string =>
  splitCodeSpans(text)
    .map((chunk) =>
      chunk.code
        ? chunk.text
        : transformChunk(chunk.text, index, self, unresolved)
    )
    .join("");

/**
 * Transform an Obsidian body to Blume-ready Markdown: wikilinks become route
 * links and `%%comments%%` are stripped, while fenced and inline code pass
 * through so a note documenting the syntax survives. Callouts stay blockquotes.
 */
const transformBody = (
  body: string,
  index: Map<string, IndexedNote>,
  self: IndexedNote,
  unresolved: UnresolvedTargets
): string => {
  let fence: FenceState = null;
  const out: string[] = [];
  let prose: string[] = [];
  const flush = (): void => {
    if (prose.length > 0) {
      out.push(transformProse(prose.join("\n"), index, self, unresolved));
      prose = [];
    }
  };
  for (const line of body.split("\n")) {
    const next = nextFenceState(line, fence);
    if (fence !== null || next !== null) {
      flush();
      fence = next;
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join("\n");
};

/**
 * An explicit frontmatter title wins, then the filename — how Obsidian titles
 * notes. `index` names a route rather than a note, so an untitled one falls
 * through to Blume's own derivation instead of publishing as "index".
 */
const titleFor = (
  rel: string,
  frontmatterTitle: SourceEntry["data"][string]
): string | undefined => {
  if (isStringValue(frontmatterTitle)) {
    return frontmatterTitle;
  }
  const noteName = basename(rel).replace(MARKDOWN_FILE, "");
  return noteName.toLowerCase() === "index" ? undefined : noteName;
};

/**
 * Lower one vault note to a staged Markdown entry, keyed by the same route
 * input {@link routeFor} used when rewriting links to it.
 */
const noteToEntry = (
  pair: IndexedPair,
  index: Map<string, IndexedNote>,
  unresolved: UnresolvedTargets
): SourceEntry => {
  const { note } = pair;
  const title = titleFor(note.rel, note.data.title);
  const merged =
    title === undefined ? { ...note.data } : { ...note.data, title };
  const text = transformBody(note.content.trim(), index, pair.self, unresolved);
  const raw = matter.stringify(`${text}\n`, merged);
  return {
    body: { format: "md", text },
    data: merged,
    hash: hashText(raw),
    raw,
    ref: note.rel,
    slug: entrySlugFor(note.rel),
    sourcePath: note.absPath,
  };
};

/**
 * Read and split one note, or null when it vanished between the walk and the
 * read. Obsidian renames and deletes notes while a dev server watches the
 * vault, and one file disappearing mid-load must not fail the whole reload.
 * Any other read failure still throws.
 */
const readNote = async (
  vaultDir: string,
  rel: string
): Promise<ParsedNote | null> => {
  const absPath = join(vaultDir, rel);
  try {
    const { content, data } = matter(await readFile(absPath, "utf-8"));
    return { absPath, content, data, rel };
  } catch (error) {
    // SAFETY: a rejected `readFile` always yields a Node system error, whose
    // `code` is the only field read here.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/** Recursively list vault-relative `.md` paths, skipping dot/excluded dirs. */
const walkVault = async (
  dir: string,
  root: string,
  exclude: Set<string>
): Promise<string[]> => {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || exclude.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop -- vault trees are shallow; parallelizing complicates ordering for no measurable win.
      found.push(...(await walkVault(full, root, exclude)));
    } else if (MARKDOWN_FILE.test(entry.name)) {
      found.push(relative(root, full));
    }
  }
  return found.toSorted();
};

/** The first few dead targets, deduplicated, for a diagnostic message. */
const sample = (targets: string[]): string =>
  [...new Set(targets)].slice(0, 5).join(", ");

/** The warnings one load raises: dead notes, then dead headings. */
const unresolvedDiagnostics = (
  name: string,
  unresolved: UnresolvedTargets
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (unresolved.notes.length > 0) {
    diagnostics.push({
      code: "BLUME_WIKILINK_UNRESOLVED",
      message: `Source "${name}" found ${unresolved.notes.length} wikilink(s) to a missing note (${sample(unresolved.notes)}); rendered as plain text.`,
      severity: "warning",
      suggestion:
        "Create the missing note, or fix the link target in Obsidian — note names are matched case-insensitively across the whole vault.",
    });
  }
  if (unresolved.ambiguous.length > 0) {
    diagnostics.push({
      code: "BLUME_WIKILINK_AMBIGUOUS",
      message: `Source "${name}" found ${unresolved.ambiguous.length} note name(s) claimed by more than one file (${sample(unresolved.ambiguous)}); bare wikilinks to them resolve to the first in vault order.`,
      severity: "warning",
      suggestion:
        "Rename one of the notes, or link to the full vault-relative path (`[[folder/Note]]`) so the target is unambiguous.",
    });
  }
  if (unresolved.anchors.length > 0) {
    diagnostics.push({
      code: "BLUME_WIKILINK_UNRESOLVED",
      message: `Source "${name}" found ${unresolved.anchors.length} wikilink(s) to a missing heading (${sample(unresolved.anchors)}); linked to the page without an anchor.`,
      severity: "warning",
      suggestion:
        "Fix the heading text in the link, or add the heading to the target note.",
    });
  }
  return diagnostics;
};

/**
 * The built-in Obsidian vault source: read a vault directly — no export step,
 * no generated files in the user's repo — lowering Obsidian's dialect to
 * Blume-ready Markdown at load time.
 *
 * Staged, since the body is rewritten before Blume sees it; `sourcePath` still
 * points at the note, so diagnostics and relative image checks name the real
 * file. A wikilink Blume cannot resolve degrades rather than failing the build.
 */
export const obsidianSource = (
  options: ObsidianSourceOptions,
  ctx: SourceContext
): ContentSource => {
  const vaultDir = resolve(ctx.projectRoot, options.vault);
  const exclude = new Set(options.exclude);
  let snapshot = new Map<string, SourceEntry>();

  const load = async (): Promise<SourceLoadResult> => {
    const files = await walkVault(vaultDir, vaultDir, exclude);
    const read = await Promise.all(files.map((rel) => readNote(vaultDir, rel)));
    const notes = read.filter((note): note is ParsedNote => note !== null);
    // Resolving `[[Note#H]]` needs the target's route and headings, so every
    // note is parsed first. Headings come from the rendered body and rendering
    // needs the index, so the rewrite runs twice: the first pass settles each
    // heading's final text, the second has real anchors and produces what ships.
    const routesOnly = buildNoteIndex(
      notes,
      options.prefix,
      noTargets(),
      () => ""
    );
    const rendered = new Map(
      routesOnly.pairs.map(({ note, self }) => [
        note.rel,
        transformBody(note.content.trim(), routesOnly.index, self, noTargets()),
      ])
    );
    const unresolved = noTargets();
    const built = buildNoteIndex(
      notes,
      options.prefix,
      unresolved,
      (note) => rendered.get(note.rel) ?? note.content
    );
    const entries = built.pairs.map((pair) =>
      noteToEntry(pair, built.index, unresolved)
    );
    snapshot = new Map(entries.map((entry) => [entry.ref, entry]));
    return {
      diagnostics: unresolvedDiagnostics(options.name, unresolved),
      entries,
    };
  };

  const read = async (ref: string): Promise<string> => {
    const cached = snapshot.get(ref);
    if (cached) {
      return cached.raw ?? cached.body.text;
    }
    // A public SPI method reached before `load` filled the snapshot: the ref
    // is not yet known to be one of ours.
    const absPath = resolve(vaultDir, ref);
    if (relative(vaultDir, absPath).startsWith("..")) {
      throw new BlumeError({
        code: "BLUME_SOURCE_MISCONFIGURED",
        file: absPath,
        message: `Source "${options.name}" cannot read "${ref}": it resolves outside the vault.`,
        severity: "error",
        suggestion: "Reference notes by their vault-relative path.",
      });
    }
    return await readFile(absPath, "utf-8");
  };

  const validate = (): void => {
    // `existsSync` alone also accepts a regular file, which `validate` would
    // wave through and `load` would then fail on with a raw ENOTDIR.
    const stats = statSync(vaultDir, { throwIfNoEntry: false });
    if (stats?.isDirectory()) {
      return;
    }
    const problem = stats ? "is not a directory" : "does not exist";
    throw new BlumeError({
      code: "BLUME_SOURCE_MISCONFIGURED",
      file: vaultDir,
      message: `Source "${options.name}" points at "${options.vault}", which ${problem}.`,
      severity: "error",
      suggestion:
        "Set `vault` to your Obsidian vault directory, relative to the project root.",
    });
  };

  // Obsidian rewrites `.obsidian/workspace.json` as you move a pane; unfiltered,
  // every such write re-triggers a full rescan. See {@link ignoringWatchListener}.
  const watchIgnoreDirs = new Set([
    ...BLUME_WATCH_IGNORE_DIRS,
    OBSIDIAN_CONFIG_DIR,
    ...exclude,
  ]);

  const watch = (onChange: () => void): (() => void) => {
    if (!existsSync(vaultDir)) {
      return () => {
        // Nothing to dispose when the vault doesn't exist yet.
      };
    }
    const watcher = fsWatch(
      vaultDir,
      { recursive: true },
      ignoringWatchListener(onChange, watchIgnoreDirs)
    );
    return () => watcher.close();
  };

  return {
    load,
    name: options.name,
    prefix: options.prefix,
    read,
    staged: true,
    validate,
    watch,
  };
};
