import { mkdir, writeFile } from "node:fs/promises";

import matter from "gray-matter";
import { dirname, join } from "pathe";

import { sourceForMarkdown, isPublicAgentPage } from "../ai/markdown.ts";
import { slugify } from "../core/content.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { PageRecord } from "../core/types.ts";

interface UpdateRssMetadata {
  description?: string;
  title?: string;
}

interface UpdateBlock {
  attributes: Record<string, unknown>;
  body: string;
}

interface RssEntry {
  description?: string;
  link: string;
  pubDate: Date;
  title: string;
}

interface RssFeed {
  content: string;
  outputPath: string;
  route: string;
}

const FENCE = /^```/u;
const UPDATE_NAME = "Update";
const ATX_HEADING = /^\s{0,3}(?<hashes>#{1,6})\s+(?<text>.+?)\s*#*$/gmu;
const MDX_ESM_LINE = /^(?:import|export)\s.+$/gmu;
const CODE_BLOCK = /^```[\s\S]*?^```[^\n]*(?:\n|$)/gmu;
const INLINE_CODE = /`[^`\n]*`/gu;
const JSX_BLOCK_LINE = /^\s*<\/?[A-Z][\w.:-]*(?:\s[^>]*)?>\s*$/u;
const HTML_LINE = /^\s*<\/?[a-z][\w:-]*(?:\s[^>]*)?>\s*$/u;

const isBoundary = (char: string | undefined): boolean =>
  char === undefined || /[\s/>]/u.test(char);

const maskFencedCode = (source: string): string => {
  let inFence = false;
  return (source.match(/[^\n]*(?:\n|$)/gu) ?? [])
    .map((line) => {
      const startsFence = FENCE.test(line.trimStart());
      if (startsFence) {
        inFence = !inFence;
        return " ".repeat(line.length);
      }
      return inFence ? " ".repeat(line.length) : line;
    })
    .join("");
};

const readTag = (
  source: string,
  start: number
): { end: number; selfClosing: boolean } | null => {
  let quote: string | null = null;
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      braces += 1;
    } else if (char === "}" && braces > 0) {
      braces -= 1;
    } else if (char === ">" && braces === 0) {
      return {
        end: index + 1,
        selfClosing: source.slice(start, index).trimEnd().endsWith("/"),
      };
    }
  }
  return null;
};

const startsOpeningUpdate = (source: string, index: number): boolean =>
  source.startsWith(`<${UPDATE_NAME}`, index) &&
  isBoundary(source[index + UPDATE_NAME.length + 1]);

const startsClosingUpdate = (source: string, index: number): boolean =>
  source.startsWith(`</${UPDATE_NAME}`, index) &&
  isBoundary(source[index + UPDATE_NAME.length + 2]);

const nextUpdateToken = (
  source: string,
  start: number
): { closing: boolean; index: number } | null => {
  for (let index = source.indexOf("<", start); index !== -1; ) {
    if (startsClosingUpdate(source, index)) {
      return { closing: true, index };
    }
    if (startsOpeningUpdate(source, index)) {
      return { closing: false, index };
    }
    index = source.indexOf("<", index + 1);
  }
  return null;
};

const findUpdateClose = (
  source: string,
  start: number
): { closeStart: number; closeEnd: number } | null => {
  let depth = 1;
  let cursor = start;
  while (cursor < source.length) {
    const token = nextUpdateToken(source, cursor);
    if (!token) {
      return null;
    }
    const tag = readTag(source, token.index);
    if (!tag) {
      return null;
    }
    if (token.closing) {
      depth -= 1;
      if (depth === 0) {
        return { closeEnd: tag.end, closeStart: token.index };
      }
    } else if (!tag.selfClosing) {
      depth += 1;
    }
    cursor = tag.end;
  }
  return null;
};

const decodeQuoted = (value: string): string => {
  const [quote] = value;
  const body = value.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(value) as string;
    } catch {
      return body;
    }
  }
  return body.replaceAll(/\\(?<escaped>['"`\\nrt])/gu, (...args) => {
    const groups = args.at(-1) as { escaped?: string };
    const escaped = groups.escaped ?? "";
    if (escaped === "n") {
      return "\n";
    }
    if (escaped === "r") {
      return "\r";
    }
    if (escaped === "t") {
      return "\t";
    }
    return escaped;
  });
};

const isQuotedValue = (value: string): boolean =>
  (value.startsWith('"') && value.endsWith('"')) ||
  (value.startsWith("'") && value.endsWith("'")) ||
  (value.startsWith("`") && value.endsWith("`"));

const splitTopLevel = (source: string): string[] => {
  const parts: string[] = [];
  let quote: string | null = null;
  let braces = 0;
  let brackets = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      braces += 1;
    } else if (char === "}" && braces > 0) {
      braces -= 1;
    } else if (char === "[") {
      brackets += 1;
    } else if (char === "]" && brackets > 0) {
      brackets -= 1;
    } else if (char === "," && braces === 0 && brackets === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
};

const splitProperty = (
  source: string
): { key: string; value: string } | null => {
  let quote: string | null = null;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      braces += 1;
    } else if (char === "}" && braces > 0) {
      braces -= 1;
    } else if (char === "[") {
      brackets += 1;
    } else if (char === "]" && brackets > 0) {
      brackets -= 1;
    } else if (char === ":" && braces === 0 && brackets === 0) {
      const key = source.slice(0, index).trim();
      const value = source.slice(index + 1).trim();
      return { key, value };
    }
  }
  return null;
};

const staticObjectKey = (rawKey: string): string =>
  isQuotedValue(rawKey) ? decodeQuoted(rawKey) : rawKey;

const parseStaticObject = (
  source: string,
  parseValue: (value: string) => unknown
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const part of splitTopLevel(source.slice(1, -1))) {
    const property = splitProperty(part);
    if (!property) {
      continue;
    }
    result[staticObjectKey(property.key.trim())] = parseValue(property.value);
  }
  return result;
};

const parseStaticValue = (source: string): unknown => {
  const value = source.trim();
  if (!value) {
    return undefined;
  }
  if (isQuotedValue(value)) {
    return decodeQuoted(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevel(value.slice(1, -1)).map(parseStaticValue);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    return parseStaticObject(value, parseStaticValue);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  const number = Number(value);
  return Number.isNaN(number) ? undefined : number;
};

const readExpression = (
  source: string,
  start: number
): { end: number; value: string } | null => {
  let quote: string | null = null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { end: index + 1, value: source.slice(start + 1, index) };
      }
    }
  }
  return null;
};

const readQuotedAttribute = (
  source: string,
  start: number
): { end: number; value: string } | null => {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
    } else if (char === quote) {
      return {
        end: index + 1,
        value: decodeQuoted(source.slice(start, index + 1)),
      };
    }
  }
  return null;
};

const skipWhitespace = (source: string, start: number): number => {
  let cursor = start;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
};

const readAttributeName = (
  source: string,
  start: number
): { end: number; name: string } | null => {
  const match = source.slice(start).match(/^(?<name>[$A-Z_a-z][$\w.-]*)/u);
  const name = match?.groups?.name;
  return name ? { end: start + name.length, name } : null;
};

const readAttributeValue = (
  source: string,
  start: number
): { end: number; value: unknown } | null => {
  const cursor = skipWhitespace(source, start);
  const char = source[cursor];
  if (char === '"' || char === "'" || char === "`") {
    return readQuotedAttribute(source, cursor);
  }
  if (char === "{") {
    const expression = readExpression(source, cursor);
    return expression
      ? { end: expression.end, value: parseStaticValue(expression.value) }
      : null;
  }
  const raw = source.slice(cursor).match(/^[^\s>]+/u)?.[0] ?? "";
  return raw ? { end: cursor + raw.length, value: raw } : null;
};

const parseAttributes = (source: string): Record<string, unknown> => {
  const attributes: Record<string, unknown> = {};
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    const attribute = readAttributeName(source, cursor);
    if (!attribute) {
      cursor += 1;
      continue;
    }
    cursor = skipWhitespace(source, attribute.end);
    if (source[cursor] !== "=") {
      attributes[attribute.name] = true;
      continue;
    }
    const value = readAttributeValue(source, cursor + 1);
    attributes[attribute.name] = value?.value;
    cursor = value?.end ?? cursor + 1;
  }
  return attributes;
};

const extractUpdateBlocks = (source: string): UpdateBlock[] => {
  const masked = maskFencedCode(source);
  const blocks: UpdateBlock[] = [];
  let cursor = 0;
  while (cursor < masked.length) {
    const token = nextUpdateToken(masked, cursor);
    if (!token || token.closing) {
      break;
    }
    const tag = readTag(masked, token.index);
    if (!tag) {
      break;
    }
    if (tag.selfClosing) {
      cursor = tag.end;
      continue;
    }
    const close = findUpdateClose(masked, tag.end);
    if (!close) {
      break;
    }
    const rawAttributes = source
      .slice(token.index + `<${UPDATE_NAME}`.length, tag.end - 1)
      .trim()
      .replace(/\/$/u, "")
      .trim();
    blocks.push({
      attributes: parseAttributes(rawAttributes),
      body: source.slice(tag.end, close.closeStart),
    });
    cursor = close.closeEnd;
  }
  return blocks;
};

const stringAttribute = (attributes: Record<string, unknown>, key: string) => {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const rssAttribute = (
  attributes: Record<string, unknown>
): UpdateRssMetadata | undefined => {
  const value = attributes.rss;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rss = value as Record<string, unknown>;
  return {
    description:
      typeof rss.description === "string" ? rss.description : undefined,
    title: typeof rss.title === "string" ? rss.title : undefined,
  };
};

const cleanMarkdown = (source: string): string =>
  source
    .replaceAll(CODE_BLOCK, "")
    .replaceAll(MDX_ESM_LINE, "")
    .replaceAll(INLINE_CODE, "")
    .split(/\r?\n/u)
    .filter((line) => !JSX_BLOCK_LINE.test(line) && !HTML_LINE.test(line))
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

const headingSections = (
  source: string
): { anchor: string; body: string; title: string }[] => {
  const headings = [...source.matchAll(ATX_HEADING)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end =
      index + 1 < headings.length
        ? (headings[index + 1]?.index ?? source.length)
        : source.length;
    const title = heading.groups?.text?.trim() ?? "Update";
    return {
      anchor: slugify(title) || "update",
      body: cleanMarkdown(source.slice(start, end)),
      title,
    };
  });
};

const parseDate = (...values: (string | undefined)[]): Date => {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const time = Date.parse(value);
    if (!Number.isNaN(time)) {
      return new Date(time);
    }
  }
  return new Date(0);
};

const routeUrl = (route: string, site?: string): string => {
  if (!site) {
    return route;
  }
  return `${site.replace(/\/$/u, "")}${route}`;
};

const rssRoute = (route: string): string =>
  route === "/" ? "/rss.xml" : `${route.replace(/\/$/u, "")}/rss.xml`;

const itemLink = (route: string, anchor: string, site?: string): string =>
  `${routeUrl(route, site)}#${anchor}`;

const cdata = (value: string): string =>
  `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const updateEntries = (
  block: UpdateBlock,
  route: string,
  site?: string
): RssEntry[] => {
  const label =
    stringAttribute(block.attributes, "label") ??
    stringAttribute(block.attributes, "title") ??
    "Update";
  const description = stringAttribute(block.attributes, "description");
  const rss = rssAttribute(block.attributes);
  const pubDate = parseDate(label, description);
  const labelAnchor = slugify(label) || "update";
  if (rss?.title || rss?.description) {
    return [
      {
        description: rss.description,
        link: itemLink(route, labelAnchor, site),
        pubDate,
        title: rss.title ?? label,
      },
    ];
  }

  const sections = headingSections(block.body);
  if (sections.length > 0) {
    return sections.map((section) => ({
      description: section.body || description,
      link: itemLink(route, section.anchor, site),
      pubDate,
      title: section.title,
    }));
  }

  return [
    {
      description: cleanMarkdown(block.body) || description,
      link: itemLink(route, labelAnchor, site),
      pubDate,
      title: label,
    },
  ];
};

const feedOutputPath = (outDir: string, route: string): string =>
  route === "/"
    ? join(outDir, "rss.xml")
    : join(outDir, route.replaceAll(/^\/|\/$/gu, ""), "rss.xml");

const buildFeed = (
  project: BlumeProject,
  page: PageRecord,
  entries: RssEntry[]
): RssFeed => {
  const { site } = project.config.deployment;
  const feedPath = rssRoute(page.route);
  const feedUrl = routeUrl(feedPath, site);
  const pageUrl = routeUrl(page.route, site);
  const description =
    page.description ?? project.config.description ?? `${page.title} updates`;
  const lastBuildDate = new Date(
    Math.max(...entries.map((entry) => entry.pubDate.getTime()))
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">',
    "  <channel>",
    `    <title>${cdata(page.title)}</title>`,
    `    <description>${cdata(description)}</description>`,
    `    <link>${escapeXmlAttribute(pageUrl)}</link>`,
    "    <generator>Blume</generator>",
    `    <lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>`,
    `    <atom:link href="${escapeXmlAttribute(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `    <copyright>${cdata(project.config.title)}</copyright>`,
    "    <docs>https://www.rssboard.org/rss-specification</docs>",
  ];
  for (const entry of entries) {
    lines.push(
      "    <item>",
      `      <title>${cdata(entry.title)}</title>`,
      `      <link>${escapeXmlAttribute(entry.link)}</link>`,
      `      <guid isPermaLink="true">${escapeXmlAttribute(entry.link)}</guid>`,
      `      <pubDate>${entry.pubDate.toUTCString()}</pubDate>`
    );
    if (entry.description) {
      lines.push(
        `      <description>${cdata(entry.description)}</description>`
      );
    }
    lines.push("    </item>");
  }
  lines.push("  </channel>", "</rss>");
  return {
    content: `${lines.join("\n")}\n`,
    outputPath: feedOutputPath("", page.route),
    route: feedPath,
  };
};

export const buildChangelogRssFeeds = async (
  project: BlumeProject
): Promise<RssFeed[]> => {
  const pages = project.graph.pages.filter(
    (page) => !page.meta.draft && isPublicAgentPage(page)
  );
  const feeds = await Promise.all(
    pages.map(async (page) => {
      const source = await sourceForMarkdown(project, page);
      const { content } = matter(source);
      const entries = extractUpdateBlocks(content).flatMap((block) =>
        updateEntries(block, page.route, project.config.deployment.site)
      );
      return entries.length > 0 ? buildFeed(project, page, entries) : null;
    })
  );
  return feeds.filter((feed): feed is RssFeed => feed !== null);
};

export const writeChangelogRssFeeds = async (
  project: BlumeProject,
  outDir: string
): Promise<number> => {
  const feeds = await buildChangelogRssFeeds(project);
  await Promise.all(
    feeds.map(async (feed) => {
      const output = join(outDir, feed.outputPath);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, feed.content, "utf-8");
    })
  );
  return feeds.length;
};
