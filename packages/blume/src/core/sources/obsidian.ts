import { existsSync, watch as fsWatch, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";

import { basename, isAbsolute, join, relative, resolve } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import { pageMetaSchema } from "../schema.ts";
import type { ResolvedI18nConfig, ResolvedVersionsConfig } from "../schema.ts";
import type { Diagnostic } from "../types.ts";
import { hashText } from "./cache.ts";
import type { EntryPlacement, FenceState } from "./normalize.ts";
import {
  extractHeadings,
  isStringValue,
  localizedRoute,
  nextFenceState,
  placeEntryRef,
  resolveEntryRoute,
  slugifyPath,
} from "./normalize.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";
import { BLUME_IGNORE_DIRS, ignoringWatchListener } from "./watch.ts";

/** Options for the built-in Obsidian vault source. */
export interface ObsidianSourceOptions {
  /**
   * The project's default content type (`content.defaultType`), which a note
   * without a `type` resolves to when {@link typeFrontmatterKeys} are picked.
   */
  defaultType?: string;
  /** Vault folder names to skip at any depth, in addition to dot-folders. */
  exclude?: string[];
  /**
   * Frontmatter keys the project declares site-wide beyond Blume's page meta
   * (`frontmatter.extend`). Any other Obsidian property is dropped when a note
   * is lowered, since the strict meta schema would reject it and fail the
   * build.
   */
  frontmatterKeys?: readonly string[];
  /** The project's i18n config, when locale directories place vault notes. */
  i18n?: ResolvedI18nConfig;
  /** Stable source name; namespaces ids and diagnostics. */
  name: string;
  /** Namespaces the source's routes under `/<prefix>/`; e.g. `vault`. */
  prefix?: string;
  /**
   * Frontmatter keys each content type declares (`content.types.<type>.frontmatter`),
   * keyed by type. A note keeps only the keys of its own type — the meta parse
   * merges only that type's schema, so a key another type declares would still
   * reach the strict page schema and fail.
   */
  typeFrontmatterKeys?: Readonly<Record<string, readonly string[]>>;
  /** Vault directory, absolute or relative to `projectRoot`. */
  vault: string;
  /** The project's versions config, when snapshot directories hold notes. */
  versions?: ResolvedVersionsConfig;
}

const MARKDOWN_FILE = /\.md$/iu;
/** `%%comment%%` on a single line; multi-line comments are not stripped yet. */
const OBSIDIAN_COMMENT = /%%.*?%%/gu;
/**
 * `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]`. The
 * target and heading are lazy so the `\|` Obsidian writes for an alias inside
 * a table cell (a bare `|` would end the cell) is read as the alias separator
 * rather than as a backslash ending the target. A target cannot open with `[`:
 * Obsidian reads `[[[Note]]]` as a literal `[`, the link, and a literal `]`,
 * and so does the match once the first bracket is left out of it.
 */
const WIKILINK =
  /(?<embed>!)?\[\[(?<target>(?:[^\][|#\n][^\]|#\n]*?)?)(?:#(?<heading>[^\]|\n]+?))?(?:\\?\|(?<alias>[^\]\n]+))?\]\]/gu;

/** A vault note, read and split into frontmatter and body. */
interface ParsedNote {
  absPath: string;
  /** The note body, frontmatter stripped and otherwise untouched. */
  content: string;
  data: SourceEntry["data"];
  placement: EntryPlacement;
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

/** A Markdown link or image, reduced to its text by {@link headingKey}. */
const INLINE_LINK = /!?\[(?<text>[^\]]*)\]\([^)]*\)/gu;
/**
 * Inline formatting Obsidian drops when it autocompletes a heading link:
 * emphasis and strikethrough marks, code-span backticks, and an `_` that opens
 * or closes a word (one inside `snake_case` is text).
 */
const INLINE_MARKS = /[*~`]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;

/**
 * The key a heading is indexed and looked up under: its text with inline
 * Markdown stripped, because Obsidian writes `[[Note#Bold heading]]` for a
 * `## **Bold** heading` — and because that is the text the rendered id is
 * slugged from.
 */
const headingKey = (text: string): string =>
  indexKey(
    text.replaceAll(INLINE_LINK, "$<text>").replaceAll(INLINE_MARKS, "")
  );

/**
 * Obsidian's own default properties (the Properties UI writes the plural
 * spellings; older vaults carry the singular ones). They are not Blume
 * frontmatter, so they are dropped even when a project happens to declare a
 * key of the same name. `aliases` is dropped rather than resolved; alias link
 * targets are not supported yet.
 */
const OBSIDIAN_NATIVE_KEYS = new Set([
  "alias",
  "aliases",
  "cssclass",
  "cssclasses",
  "tag",
  "tags",
]);

/** Every key Blume's page meta schema accepts. */
const PAGE_META_KEYS = new Set<string>(pageMetaSchema.keyof().options);

/**
 * A note's route input: its locale- and version-stripped path, slugged. Vault
 * filenames are prose (`Getting Started.md`) and the route mapper does not
 * slug, so this does — through {@link slugifyPath}, which keeps a non-Latin
 * name routable.
 */
const entrySlugFor = (navPath: string): string =>
  slugifyPath(navPath.replace(MARKDOWN_FILE, ""));

/** One note as the wikilink index knows it: where it routes, and its anchors. */
interface IndexedNote {
  /** Anchor id per heading, keyed by {@link headingKey}. */
  anchors: Map<string, string>;
  /** The locales the note publishes in — every locale for a shared `$` note. */
  locales: string[];
  /** The note's version-prefixed, locale-agnostic route, prefix included. */
  logicalRoute: string;
}

/** The wikilink lookup table. */
interface LinkIndex {
  /**
   * Bare note names claimed by more than one file, keyed by {@link indexKey},
   * with the diagnostic text naming the claimants. A name some note owns as
   * its exact vault path is not here — Obsidian resolves a path before a name.
   */
  ambiguous: Map<string, string>;
  i18n?: ResolvedI18nConfig;
  notes: Map<string, IndexedNote>;
}

/** Dead or ambiguous wikilink targets, accumulated across one load. */
interface UnresolvedTargets {
  /** Bare names a wikilink resolved through a collision, with the claimants. */
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
  index: LinkIndex;
  pairs: IndexedPair[];
}

/** A fresh accumulator. */
const noTargets = (): UnresolvedTargets => ({
  ambiguous: [],
  anchors: [],
  notes: [],
});

/**
 * The href a link from one note to another takes. A shared `Note.$.md`
 * publishes in every locale, so a link to it stays in the linking note's
 * locale rather than jumping to whichever locale is configured first; a target
 * that does not publish in that locale links to the first locale it does. The
 * Markdown pipeline prefixes every root-absolute link with `deployment.base`
 * at render time, so the base is left off here.
 */
const hrefBetween = (
  target: IndexedNote,
  from: IndexedNote,
  i18n: ResolvedI18nConfig | undefined
): string => {
  const own = from.locales[0] ?? "";
  const locale = target.locales.includes(own) ? own : (target.locales[0] ?? "");
  return localizedRoute(target.logicalRoute, locale, i18n);
};

/**
 * Every path suffix a wikilink can address a note by: `docs/guides/Setup.md`
 * yields `docs/guides/setup`, `guides/setup`, and `setup`. Obsidian's default
 * "shortest path when possible" setting writes any of them into a link, so all
 * of them must resolve.
 */
const suffixKeysOf = (rel: string): string[] => {
  const segments = rel.replace(MARKDOWN_FILE, "").split("/");
  return segments.map((_, from) => indexKey(segments.slice(from).join("/")));
};

/** Every run of backticks — the only delimiter a code span has. */
const BACKTICK_RUN = /`+/gu;

/** A run of backticks: where it starts and how many. */
interface BacktickRun {
  at: number;
  length: number;
}

/** Whether the character at `at` sits behind an odd number of backslashes. */
const isEscaped = (text: string, at: number): boolean => {
  let backslashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

/**
 * The backtick runs that can delimit a code span. A backslash escapes the one
 * backtick after it (CommonMark 2.4), so an escaped run loses its first tick
 * — and drops out entirely when that was its only one.
 */
const backtickRuns = (text: string): BacktickRun[] => {
  const runs: BacktickRun[] = [];
  for (const match of text.matchAll(BACKTICK_RUN)) {
    const escaped = isEscaped(text, match.index);
    const at = escaped ? match.index + 1 : match.index;
    const length = escaped ? match[0].length - 1 : match[0].length;
    if (length > 0) {
      runs.push({ at, length });
    }
  }
  return runs;
};

/** One piece of a line: literal text the rewrite must not touch, or prose. */
interface LineChunk {
  literal: boolean;
  text: string;
}

/** A span of text that is literal: a code span or an HTML comment. */
interface LiteralSpan {
  end: number;
  start: number;
}

/** The index of the next backtick run of exactly `length`, or -1. */
const closerAfter = (
  runs: BacktickRun[],
  from: number,
  length: number
): number => {
  for (let i = from; i < runs.length; i += 1) {
    if (runs[i]?.length === length) {
      return i;
    }
  }
  return -1;
};

/**
 * The first code span opening at or after `from`. A run of N backticks opens
 * a span only if a run of exactly N follows — one regex expresses neither the
 * length match nor that condition — and a run with no closer is literal text
 * that the scan steps over.
 */
const nextCodeSpan = (
  runs: BacktickRun[],
  from: number
): LiteralSpan | null => {
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run === undefined || run.at < from) {
      continue;
    }
    const close = closerAfter(runs, i + 1, run.length);
    if (close !== -1) {
      return { end: (runs[close]?.at ?? 0) + run.length, start: run.at };
    }
  }
  return null;
};

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/**
 * The first HTML comment opening at or after `from`. Obsidian hides one in
 * reading view, so a wikilink inside it is never a link the reader sees; an
 * unclosed `<!--` is literal text (CommonMark 6.6), not a comment to the end.
 */
const nextComment = (text: string, from: number): LiteralSpan | null => {
  const start = text.indexOf(COMMENT_OPEN, from);
  if (start === -1) {
    return null;
  }
  const close = text.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length);
  return close === -1 ? null : { end: close + COMMENT_CLOSE.length, start };
};

/**
 * Split prose into literal and rewritable chunks. Code spans and HTML comments
 * have equal precedence and the leftmost wins (CommonMark 6.6): a `<!--`
 * inside a code span is code, and a backtick inside a comment is comment. The
 * scan runs over a whole run of prose rather than a line, because either may
 * hold newlines while an unclosed opener is literal text.
 */
const splitLiterals = (text: string): LineChunk[] => {
  const runs = backtickRuns(text);
  const chunks: LineChunk[] = [];
  let cursor = 0;
  for (;;) {
    const code = nextCodeSpan(runs, cursor);
    const comment = nextComment(text, cursor);
    const span =
      code === null || (comment !== null && comment.start < code.start)
        ? comment
        : code;
    if (span === null) {
      break;
    }
    chunks.push(
      { literal: false, text: text.slice(cursor, span.start) },
      { literal: true, text: text.slice(span.start, span.end) }
    );
    cursor = span.end;
  }
  chunks.push({ literal: false, text: text.slice(cursor) });
  return chunks;
};

/** Rewrite one chunk's wikilinks and strip single-line comments. */
const transformChunk = (
  chunk: string,
  index: LinkIndex,
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
      const ownHref = hrefBetween(self, self, index.i18n);
      // `#^block-id` names a block, not a heading. Blocks render with no
      // anchor to land on, so the link goes to the page itself rather than
      // warning about a heading that never existed. The caret never reaches
      // the label — `[^id]` would read as a GFM footnote reference.
      if (heading.startsWith("^")) {
        return `[${groups.alias?.trim() || heading.slice(1)}](${ownHref})`;
      }
      const own = self.anchors.get(headingKey(heading));
      if (own === undefined) {
        // Same rule as a missing heading in another note: keep the page link,
        // drop only the anchor.
        unresolved.anchors.push(`#${heading}`);
        return `[${label}](${ownHref})`;
      }
      return `[${label}](${ownHref}#${own})`;
    }
    // `[[Note.md]]` is the path form Obsidian also accepts; the index is keyed
    // without the extension.
    const key = indexKey(target.replace(MARKDOWN_FILE, ""));
    const note = index.notes.get(key);
    if (note === undefined) {
      unresolved.notes.push(target);
      return label;
    }
    const clash = index.ambiguous.get(key);
    if (clash !== undefined) {
      unresolved.ambiguous.push(clash);
    }
    const href = hrefBetween(note, self, index.i18n);
    if (heading === undefined) {
      return `[${label}](${href})`;
    }
    // A block reference links to its note without an anchor; block ids are
    // generated noise (`^a1b2c3`), so an unaliased one reads as the note name.
    if (heading.startsWith("^")) {
      return `[${groups.alias?.trim() || target}](${href})`;
    }
    const anchor = note.anchors.get(headingKey(heading));
    if (anchor === undefined) {
      // The note is real, so keep the link and drop only the anchor — landing
      // on the page beats degrading the whole link to plain text.
      unresolved.anchors.push(`${target}#${heading}`);
      return `[${label}](${href})`;
    }
    return `[${label}](${href}#${anchor})`;
  });

/**
 * Rewrite a run of prose, leaving inline code spans (`` `[[x]]` ``) and HTML
 * comments (`<!-- [[x]] -->`) verbatim.
 */
const transformProse = (
  text: string,
  index: LinkIndex,
  self: IndexedNote,
  unresolved: UnresolvedTargets
): string =>
  splitLiterals(text)
    .map((chunk) =>
      chunk.literal
        ? chunk.text
        : transformChunk(chunk.text, index, self, unresolved)
    )
    .join("");

/** An indented code block's marker: four spaces or a tab (CommonMark 4.4). */
const INDENTED_CODE = /^(?: {4}|\t)/u;
/** A list item opener (CommonMark 5.2), which makes later indentation prose. */
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: |$)/u;

/** How many leading whitespace characters a line carries. */
const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/**
 * Whether a list is open after `line`: an item opens one, and it stays open
 * until a non-blank line that is neither an item nor indented.
 */
const listAfter = (line: string, inList: boolean): boolean => {
  if (line.trim() === "") {
    return inList;
  }
  if (LIST_ITEM.test(line)) {
    return true;
  }
  return line.startsWith(" ") || line.startsWith("\t") ? inList : false;
};

/**
 * The fence state after `line`. Outside a list, a line indented four or more
 * spaces is never a fence delimiter: it is indented code or a continuation
 * line. Inside a list item the content indent is the item's, so a fence
 * there is written four spaces deep (`1. step` then `    ```js`) and must
 * still open. Once a fence is open only a run at most three spaces deeper
 * than it (CommonMark 4.5) closes it; a deeper run is content.
 */
const fenceAfter = (
  line: string,
  fence: FenceState,
  fenceIndent: number,
  inList: boolean
): FenceState => {
  const canDelimit =
    fence === null
      ? inList || !INDENTED_CODE.test(line)
      : indentOf(line) <= fenceIndent + 3;
  return canDelimit ? nextFenceState(line, fence) : fence;
};

/**
 * Transform an Obsidian body to Blume-ready Markdown: wikilinks become route
 * links and `%%comments%%` are stripped, while fenced, indented, and inline
 * code pass through so a note documenting the syntax survives. Callouts stay
 * blockquotes.
 */
const transformBody = (
  body: string,
  index: LinkIndex,
  self: IndexedNote,
  unresolved: UnresolvedTargets
): string => {
  let fence: FenceState = null;
  // The indent the open fence was written at: a closing fence may sit up to
  // three spaces deeper (CommonMark 4.5), and a deeper run is content.
  let fenceIndent = 0;
  // An indented code block opens only after a blank line (CommonMark: it
  // cannot interrupt a paragraph) and outside a list (a loose item's indented
  // continuation paragraph is prose), then runs while lines stay indented or
  // blank. A list stays open until a non-indented line that is not an item.
  let afterBlank = true;
  let indentedCode = false;
  let inList = false;
  const out: string[] = [];
  let prose: string[] = [];
  const flush = (): void => {
    if (prose.length > 0) {
      out.push(transformProse(prose.join("\n"), index, self, unresolved));
      prose = [];
    }
  };
  for (const line of body.split("\n")) {
    const blank = line.trim() === "";
    if (fence === null && indentedCode) {
      if (blank || INDENTED_CODE.test(line)) {
        out.push(line);
        afterBlank = blank;
        continue;
      }
      indentedCode = false;
    }
    inList = listAfter(line, inList);
    if (
      fence === null &&
      afterBlank &&
      !(blank || inList) &&
      INDENTED_CODE.test(line)
    ) {
      flush();
      indentedCode = true;
      out.push(line);
      afterBlank = false;
      continue;
    }
    const next: FenceState = fenceAfter(line, fence, fenceIndent, inList);
    if (fence !== null || next !== null) {
      if (fence === null) {
        fenceIndent = indentOf(line);
      }
      flush();
      fence = next;
      out.push(line);
      afterBlank = blank;
      continue;
    }
    if (blank) {
      // A code span cannot cross a blank line (CommonMark 6.1), so each prose
      // run flushes at one — a stray backtick stays confined to its paragraph
      // instead of pairing with another paragraph's and swallowing the links
      // between them.
      flush();
      out.push(line);
      afterBlank = true;
      continue;
    }
    prose.push(line);
    afterBlank = false;
  }
  flush();
  return out.join("\n");
};

/**
 * Fill a note's anchors: the id the renderer emits for each heading, keyed by
 * {@link headingKey}. The ids are whatever {@link extractHeadings} assigns —
 * the same pass fills the page manifest from the staged body, so a
 * `[#custom-id]` pin and the `setup-1` a later collision gets are honored
 * rather than re-slugged. When no heading holds anything the rewrite changes,
 * the raw body's headings are the staged body's; otherwise the body is lowered
 * once more so the headings are scanned exactly as they ship. A link inside a
 * heading is rewritten here before the other notes' anchors are known, so its
 * own anchor is left off; that only moves the manifest id of a heading that
 * itself holds a heading link, which the docs already flag as unaddressable.
 */
const fillAnchors = (pair: IndexedPair, index: LinkIndex): void => {
  const raw = extractHeadings(pair.note.content);
  const rewritten = raw.some(
    (heading) =>
      transformProse(heading.text, index, pair.self, noTargets()) !==
      heading.text
  );
  const headings = rewritten
    ? extractHeadings(
        transformBody(pair.note.content, index, pair.self, noTargets())
      )
    : raw;
  for (const heading of headings) {
    const key = headingKey(heading.text);
    // Obsidian points a repeated-heading link at the first match; the manifest
    // scan has already disambiguated the later ones (`setup-1`).
    if (!pair.self.anchors.has(key)) {
      pair.self.anchors.set(key, heading.slug);
    }
  }
};

/**
 * Obsidian addresses `[[Name]]` by note name, not only by path; index each note
 * under every suffix of its vault-relative path, bare basename included. A key
 * two notes share resolves to the first in vault order — Obsidian disambiguates
 * by the linking note's location, which a rewrite cannot know — except that a
 * note's exact full path always wins for its own key, the way Obsidian resolves
 * a link as a path before a name. Only a bare-name collision is recorded, and
 * only so a link that actually resolves through it can warn; a longer shared
 * suffix is already the author's disambiguation.
 */
const buildLinkIndex = (
  notes: ParsedNote[],
  options: Pick<ObsidianSourceOptions, "i18n" | "prefix" | "versions">
): NoteIndex => {
  const entries = new Map<string, IndexedNote>();
  const indexed = (note: ParsedNote): IndexedNote => {
    const cached = entries.get(note.rel);
    if (cached) {
      return cached;
    }
    // The route the pipeline will assign, from the same resolver
    // `normalizeEntry` uses — keyed by the same ref, slug, and frontmatter
    // `slug` the staged entry carries, so the two cannot disagree.
    const route = resolveEntryRoute(
      { ref: note.rel, slug: entrySlugFor(note.placement.navPath) },
      ".md",
      isStringValue(note.data.slug) ? note.data.slug : undefined,
      options
    );
    const built: IndexedNote = {
      anchors: new Map(),
      locales: route.locales,
      logicalRoute: route.logicalRoute,
    };
    entries.set(note.rel, built);
    return built;
  };
  const claims = new Map<string, [ParsedNote, ...ParsedNote[]]>();
  for (const note of notes) {
    for (const key of suffixKeysOf(note.rel)) {
      const claimed = claims.get(key);
      if (claimed) {
        claimed.push(note);
      } else {
        claims.set(key, [note]);
      }
    }
  }
  const exactKeys = new Set(
    notes.map((note) => indexKey(note.rel.replace(MARKDOWN_FILE, "")))
  );
  const index: LinkIndex = {
    ambiguous: new Map(),
    i18n: options.i18n,
    notes: new Map(),
  };
  for (const [key, claimants] of claims) {
    const [first, ...rest] = claimants;
    if (rest.length > 0 && !key.includes("/") && !exactKeys.has(key)) {
      index.ambiguous.set(
        key,
        `${key} (${claimants.map((note) => note.rel).join(", ")})`
      );
    }
    index.notes.set(key, indexed(first));
  }
  const pairs = notes.map((note) => {
    const self = indexed(note);
    // Set last, over any name or suffix claim another note holds on this key:
    // an exact vault-relative path is never ambiguous.
    index.notes.set(indexKey(note.rel.replace(MARKDOWN_FILE, "")), self);
    return { note, self };
  });
  // Anchors need every href in place (a heading may hold a wikilink), so they
  // fill in after the routes.
  for (const pair of pairs) {
    fillAnchors(pair, index);
  }
  return { index, pairs };
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
 * The declared keys a note keeps: the site-wide ones plus those of its own
 * content type, resolved the way the meta parse resolves it (`type` falling
 * back to the project default). A non-string `type` fails the strict parse
 * later regardless, so which per-type list it picks never matters.
 */
const keptKeysFor = (
  data: SourceEntry["data"],
  options: Pick<
    ObsidianSourceOptions,
    "defaultType" | "frontmatterKeys" | "typeFrontmatterKeys"
  >
): Set<string> => {
  const entryType = isStringValue(data.type) ? data.type : options.defaultType;
  const typeKeys =
    entryType === undefined
      ? []
      : (options.typeFrontmatterKeys?.[entryType] ?? []);
  return new Set([...(options.frontmatterKeys ?? []), ...typeKeys]);
};

/**
 * Lower one vault note to a staged Markdown entry, keyed by the same route
 * input the link index used when rewriting links to it. Frontmatter keeps
 * what Blume's page meta accepts plus what the project declares for the note's
 * type; every other Obsidian property (Dataview fields, Templater dates,
 * `publish`, …) is dropped rather than failing the strict schema.
 */
const noteToEntry = (
  pair: IndexedPair,
  index: LinkIndex,
  options: Pick<
    ObsidianSourceOptions,
    "defaultType" | "frontmatterKeys" | "typeFrontmatterKeys"
  >,
  unresolved: UnresolvedTargets
): SourceEntry => {
  const { note } = pair;
  const title = titleFor(note.rel, note.data.title);
  const keep = keptKeysFor(note.data, options);
  const data = Object.fromEntries(
    Object.entries(note.data).filter(
      ([key]) =>
        !OBSIDIAN_NATIVE_KEYS.has(key) &&
        (PAGE_META_KEYS.has(key) || keep.has(key))
    )
  );
  const merged = title === undefined ? data : { ...data, title };
  const text = transformBody(note.content.trim(), index, pair.self, unresolved);
  const raw = matter.stringify(`${text}\n`, merged);
  return {
    body: { format: "md", text },
    data: merged,
    hash: hashText(raw),
    raw,
    ref: note.rel,
    slug: entrySlugFor(note.placement.navPath),
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
  rel: string,
  options: Pick<ObsidianSourceOptions, "i18n" | "versions">
): Promise<ParsedNote | null> => {
  const absPath = join(vaultDir, rel);
  try {
    const { content, data } = matter(await readFile(absPath, "utf-8"));
    return {
      absPath,
      content,
      data,
      // Version outermost, then locale, the way `normalizeEntry` reads the
      // ref — the slug is built from what remains, so the pipeline's own
      // re-prefixing does not stack a second `fr/` or `v1.0/` onto the route.
      placement: placeEntryRef(rel, ".md", options),
      rel,
    };
  } catch (error) {
    // SAFETY: a rejected `readFile` always yields a Node system error, whose
    // `code` is the only field read here.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/** A directory entry with symlinks resolved to what they point at. */
interface VaultEntry {
  directory: boolean;
  file: boolean;
  name: string;
}

/**
 * A dot-name is never content: Obsidian's own `.obsidian/` and `.trash/`, and
 * the caches plugins keep in dot-folders. The walk and the watcher apply the
 * same rule, so a write into one of them neither publishes nor rescans.
 */
const isHidden = (name: string): boolean => name.startsWith(".");

/**
 * Classify one directory entry, following a symlink to what it points at the
 * way the filesystem source's glob does — a vault that symlinks a shared
 * folder in must publish it, not report every link into it as a missing
 * note. A link that cannot be followed (dangling, or a loop) is left to the
 * read when it names a note: a missing target is then the same vanished file
 * a mid-load delete produces, and anything else is the real failure it is.
 */
const classify = async (dir: string, entry: Dirent): Promise<VaultEntry> => {
  if (!entry.isSymbolicLink()) {
    return {
      directory: entry.isDirectory(),
      file: entry.isFile(),
      name: entry.name,
    };
  }
  try {
    const target = await stat(join(dir, entry.name));
    return {
      directory: target.isDirectory(),
      file: target.isFile(),
      name: entry.name,
    };
  } catch {
    return {
      directory: false,
      file: MARKDOWN_FILE.test(entry.name),
      name: entry.name,
    };
  }
};

/**
 * Vault order, the way Obsidian's file explorer lists a folder: subfolders
 * first, then notes, each case-insensitively and numeric-aware (`Note 2`
 * before `Note 10`), with a code-point tiebreak so the order is total.
 */
const byVaultOrder = (a: VaultEntry, b: VaultEntry): number =>
  Number(b.directory) - Number(a.directory) ||
  a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) ||
  (a.name < b.name ? -1 : 1);

/** Recursively list vault-relative `.md` paths, skipping dot/excluded dirs. */
const walkVault = async (
  dir: string,
  root: string,
  exclude: ReadonlySet<string>
): Promise<string[]> => {
  const found: string[] = [];
  const listed = await readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    listed
      .filter((entry) => !(isHidden(entry.name) || exclude.has(entry.name)))
      .map((entry) => classify(dir, entry))
  );
  for (const entry of entries.toSorted(byVaultOrder)) {
    const full = join(dir, entry.name);
    if (entry.directory) {
      // oxlint-disable-next-line no-await-in-loop -- vault trees are shallow; parallelizing complicates ordering for no measurable win.
      found.push(...(await walkVault(full, root, exclude)));
    } else if (entry.file && MARKDOWN_FILE.test(entry.name)) {
      found.push(relative(root, full));
    }
  }
  return found;
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
    const names = new Set(unresolved.ambiguous).size;
    diagnostics.push({
      code: "BLUME_WIKILINK_AMBIGUOUS",
      message: `Source "${name}" found ${unresolved.ambiguous.length} wikilink(s) to ${names} note name(s) claimed by more than one file (${sample(unresolved.ambiguous)}); each resolves to the first note in vault order.`,
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
  // The never-content directories every filesystem scan skips, so a vault
  // rooted at the project (`vault: "."`) doesn't publish dependency READMEs
  // or build output — and so the scan and the watcher agree on what is
  // content.
  const exclude = new Set([...BLUME_IGNORE_DIRS, ...(options.exclude ?? [])]);

  const load = async (): Promise<SourceLoadResult> => {
    const files = await walkVault(vaultDir, vaultDir, exclude);
    const read = await Promise.all(
      files.map((rel) => readNote(vaultDir, rel, options))
    );
    const notes = read.filter((note): note is ParsedNote => note !== null);
    // Resolving `[[Note#H]]` needs the target's route and headings, so every
    // note is parsed and indexed before any body is rewritten.
    const { index, pairs } = buildLinkIndex(notes, options);
    const unresolved = noTargets();
    const entries = pairs.map((pair) =>
      noteToEntry(pair, index, options, unresolved)
    );
    return {
      diagnostics: unresolvedDiagnostics(options.name, unresolved),
      entries,
    };
  };

  // The note as written, for the SPI's lazy read. The lowered body is what
  // `load` stages, and the pipeline reads that copy; this serves the vault
  // file itself, the way the filesystem source does, without pinning a second
  // copy of every note for the life of a dev server.
  const read = async (ref: string): Promise<string> => {
    const absPath = resolve(vaultDir, ref);
    const rel = relative(vaultDir, absPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
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

  // Obsidian rewrites `.obsidian/workspace.json` as you move a pane and moves
  // a deleted note into `.trash/`; plugins keep caches in dot-folders of their
  // own. The walk publishes none of them, so a write there must not trigger a
  // rescan either. See {@link ignoringWatchListener}.
  const watch = (onChange: () => void): (() => void) => {
    if (!existsSync(vaultDir)) {
      return () => {
        // Nothing to dispose when the vault doesn't exist yet.
      };
    }
    const watcher = fsWatch(
      vaultDir,
      { recursive: true },
      ignoringWatchListener(onChange, exclude, isHidden)
    );
    return () => watcher.close();
  };

  return {
    // The vault is a real on-disk tree, so exposing it lets git last-modified
    // bound its log pathspec to the notes. Folder-meta discovery still skips
    // it — that scan is guarded on `staged`.
    contentRoot: vaultDir,
    load,
    name: options.name,
    prefix: options.prefix,
    read,
    staged: true,
    validate,
    watch,
  };
};
