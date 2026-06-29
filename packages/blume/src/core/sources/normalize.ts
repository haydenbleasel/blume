import { extname } from "pathe";

import { diagnosticsFromZod } from "../diagnostics.ts";
import { localePlacement, localizeRoute } from "../i18n.ts";
import { pageMetaSchema } from "../schema.ts";
import type { PageMeta } from "../schema.ts";
import type { Diagnostic, Heading, PageLink, PageRecord } from "../types.ts";
import type { NormalizeContext, SourceEntry } from "./types.ts";

const NUMERIC_PREFIX = /^\d+[-_.]/u;
const GROUP_FOLDER = /^\((?<label>.+)\)$/u;
const WORD_SPLIT = /[-_]/u;

/** Strip a leading numeric ordering prefix (`01-intro` -> `intro`). */
const stripNumericPrefix = (segment: string): string =>
  segment.replace(NUMERIC_PREFIX, "");

/** Detect a group folder `(name)` and return its label, else null. */
const groupLabel = (segment: string): string | null =>
  segment.match(GROUP_FOLDER)?.groups?.label ?? null;

/** GitHub-style heading slugifier. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w\s-]/gu, "")
    .replaceAll(/[\s_]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

/** Title-case a slug segment for display. */
const titleCase = (value: string): string =>
  value
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** Convert a content-root-relative path into URL + nav metadata. */
const mapRoute = (
  relativePath: string
): { segments: string[]; groups: string[]; route: string } => {
  const withoutExt = relativePath.slice(
    0,
    relativePath.length - extname(relativePath).length
  );
  const rawParts = withoutExt.split("/");

  const segments: string[] = [];
  const groups: string[] = [];

  for (const part of rawParts) {
    const group = groupLabel(part);
    if (group !== null) {
      groups.push(group);
      continue;
    }
    const clean = stripNumericPrefix(part);
    if (clean === "index") {
      continue;
    }
    segments.push(clean);
  }

  const route = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { groups, route, segments };
};

const CODE_FENCE = /^```/u;
const ATX_HEADING = /^(?<hashes>#{1,6})\s+(?<text>.+?)\s*#*$/u;

/** Extract ATX headings from markdown body, skipping fenced code blocks. */
export const extractHeadings = (body: string): Heading[] => {
  const headings: Heading[] = [];
  let inFence = false;

  for (const line of body.split("\n")) {
    if (CODE_FENCE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = line.match(ATX_HEADING);
    if (match?.groups) {
      const depth = match.groups.hashes?.length ?? 1;
      const text = (match.groups.text ?? "").trim();
      headings.push({ depth, slug: slugify(text), text });
    }
  }

  return headings;
};

const MD_LINK = /\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/gu;

/**
 * Extract link targets from a markdown body for later validation, recording the
 * 1-based line/column of each target. Skips fenced code blocks.
 */
export const extractLinks = (body: string): PageLink[] => {
  const links: PageLink[] = [];
  let inFence = false;
  let lineNumber = 0;

  for (const line of body.split("\n")) {
    lineNumber += 1;
    if (CODE_FENCE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    for (const match of line.matchAll(MD_LINK)) {
      const target = match.groups?.target;
      if (target === undefined || match.index === undefined) {
        continue;
      }
      links.push({
        column: line.indexOf(target, match.index) + 1,
        line: lineNumber,
        target,
      });
    }
  }

  return links;
};

const deriveTitle = (
  meta: PageMeta,
  headings: Heading[],
  id: string
): string => {
  if (meta.title) {
    return meta.title;
  }
  const firstHeading = headings.find((h) => h.depth === 1) ?? headings[0];
  if (firstHeading) {
    return firstHeading.text;
  }
  const base = id.split("/").pop() ?? id;
  return titleCase(stripNumericPrefix(base.replace(extname(base), "")));
};

const withPrefix = (prefix: string | undefined, path: string): string =>
  prefix ? `${prefix}/${path}` : path;

/**
 * Normalize one source entry into per-locale `PageRecord`s. This is the single
 * funnel every adapter's entries pass through, so route mapping, heading/link
 * extraction, and meta validation are identical regardless of origin.
 */
export const normalizeEntry = (
  entry: SourceEntry,
  ctx: NormalizeContext
): { pages: PageRecord[]; diagnostics: Diagnostic[] } => {
  const { format } = entry.body;
  const ext = format === "mdx" ? ".mdx" : ".md";

  const result = pageMetaSchema.safeParse(entry.data);
  if (!result.success) {
    return {
      diagnostics: diagnosticsFromZod(result.error, {
        code: "BLUME_FRONTMATTER_INVALID",
        file: entry.sourcePath ?? `${ctx.source.name}:${entry.ref}`,
      }),
      pages: [],
    };
  }

  const meta = result.data;

  // Locale and the locale-stripped nav path come from the entry's ref (a leading
  // dir, or a filename suffix under the `dot` parser), not the slug — the slug is
  // the logical, locale-agnostic path within a locale. A shared `$` file maps to
  // every locale. Remote/CMS sources without i18n placement map to one locale.
  const { i18n } = ctx;
  const { navPath: rawNavPath, locales } = i18n
    ? localePlacement(entry.ref, ext, i18n)
    : { locales: [""], navPath: entry.ref };

  const navPath = withPrefix(ctx.source.prefix, rawNavPath);
  const routeInput = withPrefix(
    ctx.source.prefix,
    meta.slug ? `${meta.slug}${ext}` : rawNavPath
  );

  const { segments, groups, route: logicalRoute } = mapRoute(routeInput);
  const headings = extractHeadings(entry.body.text);
  const { staged } = ctx.source;

  const base = {
    body: staged ? { format, text: entry.raw ?? entry.body.text } : undefined,
    collection: staged ? "staged" : undefined,
    contentType: meta.type ?? ctx.defaultType,
    description: meta.description,
    editUrl: entry.editUrl,
    entryId: staged ? `${ctx.source.name}/${entry.ref}` : undefined,
    format,
    groups,
    headings,
    id: `${ctx.source.name}:${entry.ref}`,
    lastModified: meta.lastModified ?? entry.lastModified,
    links: extractLinks(entry.body.text),
    meta,
    navPath,
    segments,
    source: { name: ctx.source.name, ref: entry.ref },
    sourcePath: entry.sourcePath,
    title: deriveTitle(meta, headings, navPath),
    translationKey: logicalRoute,
  } satisfies Omit<PageRecord, "locale" | "route">;

  // One record per locale this entry maps to (one normally; every locale for a
  // shared `$` file). All share the same id, source ref, and translation key.
  const pages = locales.map((locale) => ({
    ...base,
    locale,
    route: i18n ? localizeRoute(logicalRoute, locale, i18n) : logicalRoute,
  }));

  return { diagnostics: [], pages };
};
