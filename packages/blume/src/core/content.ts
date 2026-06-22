import { readFile } from "node:fs/promises";

import matter from "gray-matter";
import { extname, relative } from "pathe";
import { glob } from "tinyglobby";

import { diagnosticsFromZod } from "./diagnostics.ts";
import { pageMetaSchema } from "./schema.ts";
import type { PageMeta } from "./schema.ts";
import type { Diagnostic, Heading, PageRecord } from "./types.ts";

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

/** Extract link targets from markdown body for later validation. */
const extractLinks = (body: string): string[] => {
  const links: string[] = [];
  for (const match of body.matchAll(MD_LINK)) {
    const target = match.groups?.target;
    if (target) {
      links.push(target);
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

/** Discover and normalize all content pages under the content root. */
export const discoverContent = async (options: {
  contentRoot: string;
  include: string[];
  exclude: string[];
  defaultType: string;
}): Promise<{ pages: PageRecord[]; diagnostics: Diagnostic[] }> => {
  const files = await glob(options.include, {
    absolute: true,
    cwd: options.contentRoot,
    ignore: options.exclude,
    onlyFiles: true,
  });
  files.sort();

  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, "utf-8") }))
  );

  const pages: PageRecord[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const { file, source } of sources) {
    const rel = relative(options.contentRoot, file);
    const ext = extname(file).toLowerCase();
    const format = ext === ".mdx" ? "mdx" : "md";
    const parsed = matter(source);

    const result = pageMetaSchema.safeParse(parsed.data);
    if (!result.success) {
      diagnostics.push(
        ...diagnosticsFromZod(result.error, {
          code: "BLUME_FRONTMATTER_INVALID",
          file,
        })
      );
      continue;
    }

    const meta = result.data;
    const { segments, groups, route } = mapRoute(
      meta.slug ? `${meta.slug}${ext}` : rel
    );
    const headings = extractHeadings(parsed.content);

    pages.push({
      contentType: meta.type ?? options.defaultType,
      description: meta.description,
      format,
      groups,
      headings,
      id: rel,
      links: extractLinks(parsed.content),
      meta,
      route,
      segments,
      sourcePath: file,
      title: deriveTitle(meta, headings, rel),
    });
  }

  return { diagnostics, pages };
};
