import { setTimeout as sleep } from "node:timers/promises";

import pLimit from "p-limit";
import { join } from "pathe";

import { parseYouTubeId } from "../../components/content/youtube.ts";
import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import { nodeRequire } from "../node-require.ts";
import type { Diagnostic } from "../types.ts";
import { materializeAssets } from "./assets.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import type { InlineRun } from "./lower.ts";
import {
  codeFence,
  guardBlockStart,
  image,
  linkParts,
  renderInline,
} from "./lower.ts";
import { slugify, slugifyPath } from "./normalize.ts";
import type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "./types.ts";

interface NotionRichText {
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
  };
}

interface NotionProperty {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name: string } | null;
  status?: { name: string } | null;
  number?: number | null;
}

interface NotionPage {
  id: string;
  properties: Record<string, NotionProperty>;
  last_edited_time?: string;
}

/** The per-type payload a block carries under the key matching its `type`. */
interface NotionBlockPayload {
  caption?: NotionRichText[];
  checked?: boolean;
  external?: { url: string };
  file?: { url: string };
  language?: string;
  rich_text?: NotionRichText[];
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: NotionBlockPayload | boolean | string | undefined;
}

interface NotionList<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * The slice of `@notionhq/client` (v5+) this adapter relies on, so it's
 * mockable. Since API version 2025-09-03 a database's rows live in a data
 * source: `databases.retrieve` names the data sources and
 * `dataSources.query` pages through one of them.
 */
export interface NotionClientLike {
  databases: {
    retrieve: (args: { database_id: string }) => Promise<{
      data_sources: { id: string; name: string }[];
    }>;
  };
  dataSources: {
    query: (args: {
      data_source_id: string;
      start_cursor?: string;
    }) => Promise<NotionList<NotionPage>>;
  };
  blocks: {
    children: {
      list: (args: {
        block_id: string;
        start_cursor?: string;
      }) => Promise<NotionList<NotionBlock>>;
    };
  };
}

/** Notion property names mapped onto Blume meta. */
export interface NotionPropertyMap {
  /** Title property name; defaults to the database's `title`-typed property. */
  title?: string;
  /** Description property (rich_text); default `Description`. */
  description?: string;
  /** Slug property (rich_text); default `Slug`, else the slugified title. */
  slug?: string;
  /** Status property (select/status); default `Status`. */
  status?: string;
  /** Sidebar order property (number); default `Order`. */
  order?: string;
}

export interface NotionSourceOptions {
  name: string;
  prefix?: string;
  /** The Notion database id. */
  database: string;
  /**
   * Maximum concurrent Notion API requests. Notion allows an average of 3
   * requests per second per integration, so a large database must pace its
   * block-tree fan-out or every request 429s. Default 3.
   */
  concurrency?: number;
  /** Integration token; defaults to `NOTION_TOKEN`. */
  token?: string;
  properties?: NotionPropertyMap;
  /**
   * The `Status` property is treated as a publish signal: any value other than
   * this maps to `draft: true`. Defaults to `Published`; pages without a
   * Status/select property are always imported as published.
   */
  publishedValue?: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Injected for tests; otherwise built from `@notionhq/client`. */
  client?: NotionClientLike;
  /** Injected for tests; used to download images. */
  fetchImpl?: typeof fetch;
}

/** The frontmatter Blume derives from a Notion page's properties. */
interface NotionFrontmatter {
  description?: string;
  draft?: boolean;
  sidebar?: { order: number };
  title?: string;
  // Frontmatter stays an open bag downstream (`SourceEntry.data`), so admit
  // the value shapes this source writes under any future key.
  [key: string]: boolean | string | { order: number } | undefined;
}

/** Neighboring rich-text runs that link to one `href` (or none), and it. */
interface LinkedRuns {
  href?: string;
  runs: InlineRun[];
}

/**
 * Rich text as Markdown for an MDX body. The runs go through the shared
 * lowering, so a literal `{`, `<`, `*`, or `[` typed in Notion renders as
 * itself instead of opening a JSX expression, a tag, or emphasis, a code run
 * keeps its text verbatim inside a long-enough code span, neighbors share
 * their marks' delimiters, and neighbors that link to one `href` share one
 * link.
 */
const richToMarkdown = (rich: NotionRichText[] = []): string => {
  const linked: LinkedRuns[] = [];
  for (const { annotations = {}, href, plain_text: text } of rich) {
    const run: InlineRun = {
      marks: {
        bold: annotations.bold,
        code: annotations.code,
        italic: annotations.italic,
        strike: annotations.strikethrough,
      },
      text,
    };
    const last = linked.at(-1);
    if (last && last.href === (href ?? undefined)) {
      last.runs.push(run);
    } else {
      linked.push({ href: href ?? undefined, runs: [run] });
    }
  }
  return renderInline(
    linked.flatMap(({ href, runs }) => linkParts(runs, href))
  );
};

const isBlockPayload = (
  value: NotionBlockPayload | boolean | string | undefined
): value is NotionBlockPayload => typeof value === "object";

/** The payload object stored under a block's own `type` key, if present. */
const payloadOf = (block: NotionBlock): NotionBlockPayload | undefined => {
  const value = block[block.type];
  return isBlockPayload(value) ? value : undefined;
};

const blockField = (block: NotionBlock): NotionRichText[] =>
  payloadOf(block)?.rich_text ?? [];

const RATE_LIMITED = 429;
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;
const SECOND_MS = 1000;
const DEFAULT_CONCURRENCY = 3;
const ASSET_DOWNLOAD_CONCURRENCY = 4;

/**
 * Retry a Notion API call on a `429 rate_limited`, honoring the `Retry-After`
 * header and otherwise backing off exponentially. A large workspace fans out
 * many concurrent block-children requests, so without this a single 429 would
 * reject the batch and abort the whole import. The exponential wait is
 * jittered so calls rate-limited together don't retry in lockstep and trip
 * the limit again as a herd.
 */
const withNotionRetry = async <T>(
  call: () => Promise<T>,
  attempt = 0
): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    // SAFETY: Notion SDK failures are APIResponseError-shaped, carrying the
    // failed request's HTTP status; anything else reads `undefined` and is
    // rethrown below.
    const { status } = error as { status?: number };
    if (status !== RATE_LIMITED || attempt === MAX_RETRIES) {
      throw error;
    }
    // SAFETY: same APIResponseError shape — `headers` is the failed
    // response's fetch `Headers`, read with `get()`; a missing header (or
    // headers without `get`) yields no positive wait and falls back to
    // exponential backoff.
    const { headers } = error as { headers?: Headers };
    const retryAfter = Number(headers?.get?.("retry-after"));
    const wait =
      retryAfter > 0
        ? retryAfter * SECOND_MS
        : BASE_DELAY_MS * 2 ** attempt * (1 + Math.random());
    await sleep(wait);
    return withNotionRetry(call, attempt + 1);
  }
};

/** Paginate a Notion list endpoint via recursion (no await-in-loop). */
const collectAll = async <T>(
  page: (cursor?: string) => Promise<NotionList<T>>,
  cursor?: string,
  acc: T[] = []
): Promise<T[]> => {
  const res = await page(cursor);
  const all = [...acc, ...res.results];
  return res.has_more && res.next_cursor
    ? collectAll(page, res.next_cursor, all)
    : all;
};

const LIST_BLOCKS = new Set([
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
]);

/** Whether a block is a list item (so consecutive ones render as a tight list). */
const isListItem = (block: NotionBlock | undefined): boolean =>
  block !== undefined && LIST_BLOCKS.has(block.type);

const richToPlain = (rich: NotionRichText[] = []): string =>
  rich.map((node) => node.plain_text).join("");

/**
 * A string prop in JSX expression form. The quoted form (`title="…"`) keeps
 * `\"` and `\n` as literal characters — MDX decodes no escapes there, so a
 * caption holding a double quote fails to compile the whole page — where the
 * expression form (`title={"…"}`) is a JSON string literal and decodes them.
 */
const jsxString = (value: string): string => `{${JSON.stringify(value)}}`;

// `<Frame>` renders its caption as Markdown after escaping `<` and `>` itself
// (so a caption can't inject HTML), which turns the lowering's own `\<` into
// a visible `&lt;`. Its caption drops those backslashes and leaves the
// escaping to Frame; every other escape still applies.
const FRAME_ESCAPED = /\\(?=[<>])/gu;

const YOUTUBE_HOST = /(?:^|\.)(?:youtube(?:-nocookie)?\.com|youtu\.be)$/u;

// `parseYouTubeId` is host-agnostic on purpose (the component accepts bare
// ids), so gate on the hostname first: `https://cdn.example.com/live/promo.mp4`
// matches its `/live/<11 chars>` shape but is a media file, not an embed.
const isYouTubeUrl = (url: string): boolean => {
  const host = URL.parse(url)?.hostname ?? "";
  return YOUTUBE_HOST.test(host) && parseYouTubeId(url) !== null;
};

/**
 * Render a Notion `video` block. Kept out of `renderLeaf`'s switch so that
 * function stays under the complexity limit.
 */
const renderVideo = (data: NotionBlockPayload): string => {
  const url = data.external?.url ?? data.file?.url;
  if (!url) {
    return "";
  }
  const caption = richToMarkdown(data.caption);
  // A YouTube link pasted into Notion becomes a `video` block holding an
  // external URL. That URL is a watch page, not a media file, so it has to
  // become the embed component — a `<video src>` pointing at it plays nothing,
  // and `materializeAssets` would download the HTML page. The iframe's title
  // is its accessible name, so it gets the caption's plain text; the Markdown
  // rendering goes to the Frame's caption, as it does for an upload.
  const title = caption ? ` title=${jsxString(richToPlain(data.caption))}` : "";
  // Everything else (a Notion upload, or a direct link to a media file) is a
  // real video file: `materializeAssets` rewrites the `src`, which matters most
  // for uploads, whose Notion URLs are signed and expire. It finds the file by
  // that quoted `src`, where MDX decodes no backslash escapes — a JSON
  // string's `\\` and `\"` would corrupt the URL or end the attribute — so the
  // URL goes in as written, with a double quote as the `%22` it means anyway.
  // The embed's `url` takes the expression form, like every string prop here.
  const media = isYouTubeUrl(url)
    ? `<YouTube${title} url=${jsxString(url)} />`
    : `<video controls src="${url.replaceAll('"', "%22")}" />`;
  return caption
    ? `<Frame caption=${jsxString(caption.replaceAll(FRAME_ESCAPED, ""))}>\n${media}\n</Frame>`
    : media;
};

/** Render a leaf (non-container) block to Markdown, or null for containers. */
const renderLeaf = (block: NotionBlock): string | null => {
  const data = payloadOf(block) ?? {};
  const text = guardBlockStart(richToMarkdown(blockField(block)));
  switch (block.type) {
    case "paragraph": {
      return text;
    }
    case "heading_1": {
      return `# ${text}`;
    }
    case "heading_2": {
      return `## ${text}`;
    }
    case "heading_3": {
      return `### ${text}`;
    }
    case "bulleted_list_item": {
      return `- ${text}`;
    }
    case "numbered_list_item": {
      return `1. ${text}`;
    }
    case "to_do": {
      return `- [${data.checked ? "x" : " "}] ${text}`;
    }
    case "quote": {
      return `> ${text}`;
    }
    case "divider": {
      return "---";
    }
    case "code": {
      // The code's own text, verbatim: escapes would show inside the fence.
      return codeFence(richToPlain(blockField(block)), data.language ?? "");
    }
    case "image": {
      const url = data.external?.url ?? data.file?.url;
      return url ? image(richToPlain(data.caption), url) : "";
    }
    case "video": {
      return renderVideo(data);
    }
    default: {
      return null;
    }
  }
};

/**
 * Notion content source. Maps a database to a collection: each page becomes an
 * entry, its properties become frontmatter, and its block tree is converted to
 * MDX with Blume components. Images are materialized so signed URLs don't rot.
 */
export const notionSource = (
  options: NotionSourceOptions,
  ctx?: SourceContext
): ContentSource => {
  const props = options.properties ?? {};
  // A FIFO semaphore: at most N calls run at once, the rest queue. Notion's
  // rate limit is per-integration (an average of 3 req/s), and a large
  // database fans out one block-children request per page plus one per nested
  // container — an unbounded burst guarantees 429s that even the retry loop
  // can't recover from, so every API call funnels through this limiter.
  const limit = pLimit(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY));
  // Asset downloads get their own gate: they go to Notion's S3, not its rate-
  // limited API, and a slow video must not hold API slots. One gate per source
  // bounds the fan-out across every page, not just within one.
  const downloads = pLimit(ASSET_DOWNLOAD_CONCURRENCY);
  // Shared with the gate so two pages naming one asset share one download.
  const inFlight = new Map<string, Promise<string>>();
  // Every Notion API call goes through the limiter, inside the retry — so a
  // call sleeping through a backoff doesn't hold a slot while it waits.
  const notionCall = <T>(call: () => Promise<T>): Promise<T> =>
    withNotionRetry(() => limit(call));
  const cache = snapshotCache(
    ctx?.cacheDir ?? join(".blume", "cache", options.name)
  );
  const assetsDir =
    ctx?.assetsDir ?? join(".blume", "public", "blume-assets", options.name);
  const assetsBaseUrl = ctx?.assetsBaseUrl ?? `/blume-assets/${options.name}`;
  let snapshot = new Map<string, SourceEntry>();

  const resolveClient = (): NotionClientLike => {
    if (options.client) {
      return options.client;
    }
    let Client: new (config: { auth?: string }) => NotionClientLike;
    try {
      // `require`, not `import()`: an ejected app scans in
      // `astro:build:done` (see `core/node-require.ts`). The module is
      // widened first because the SDK's response unions are broader than the
      // NotionClientLike slice, so a direct assertion is rejected as
      // non-overlapping.
      const sdk: unknown = nodeRequire("@notionhq/client");
      // SAFETY: `@notionhq/client` exports a `Client` class constructable with
      // an `auth` token whose instances cover the NotionClientLike slice; the
      // local type keeps the SDK mockable without importing its types.
      ({ Client } = sdk as {
        Client: new (config: { auth?: string }) => NotionClientLike;
      });
    } catch {
      throw new BlumeError({
        code: "BLUME_SOURCE_SDK_MISSING",
        message: `Source "${options.name}" needs "@notionhq/client". Install it (e.g. \`npm install @notionhq/client\`).`,
        severity: "error",
      });
    }
    return new Client({ auth: options.token ?? process.env.NOTION_TOKEN });
  };

  const childrenOf = (
    client: NotionClientLike,
    blockId: string
  ): Promise<NotionBlock[]> =>
    collectAll((cursor) =>
      notionCall(() =>
        client.blocks.children.list({ block_id: blockId, start_cursor: cursor })
      )
    );

  // `render` is injected (rather than referenced) so this stays a forward-free
  // definition; `renderBlocks` passes itself, the way `collectAll` recurses.
  const renderContainer = async (
    client: NotionClientLike,
    block: NotionBlock,
    render: (c: NotionClientLike, b: NotionBlock[]) => Promise<string>
  ): Promise<string> => {
    const children = async (target: NotionBlock): Promise<string> => {
      if (!target.has_children) {
        return "";
      }
      return render(client, await childrenOf(client, target.id));
    };

    if (block.type === "callout") {
      const body = [
        guardBlockStart(richToMarkdown(blockField(block))),
        await children(block),
      ]
        .filter(Boolean)
        .join("\n\n");
      return `<Callout>\n${body}\n</Callout>`;
    }
    if (block.type === "toggle") {
      // The item's title renders as text, not Markdown.
      const title = jsxString(richToPlain(blockField(block)));
      return `<Accordion>\n<AccordionItem title=${title}>\n${await children(block)}\n</AccordionItem>\n</Accordion>`;
    }
    if (block.type === "column_list") {
      const cols = await childrenOf(client, block.id);
      const rendered = await Promise.all(
        cols.map(async (col) => `<Column>\n${await children(col)}\n</Column>`)
      );
      return `<Columns>\n${rendered.join("\n")}\n</Columns>`;
    }
    return `{/* unsupported Notion block: ${block.type} */}`;
  };

  const renderBlocks = async (
    client: NotionClientLike,
    blocks: NotionBlock[]
  ): Promise<string> => {
    const parts = await Promise.all(
      blocks.map(async (block) => {
        const leaf = renderLeaf(block);
        if (leaf === null) {
          return renderContainer(client, block, renderBlocks);
        }
        // Leaf blocks can still carry children (nested list items, indented
        // paragraphs); dropping them would silently lose content.
        if (!block.has_children) {
          return leaf;
        }
        const nested = await renderBlocks(
          client,
          await childrenOf(client, block.id)
        );
        if (!nested) {
          return leaf;
        }
        if (isListItem(block)) {
          // Indent past the list marker so the children belong to the item
          // (`1. ` needs three columns, `- `/`- [x] ` two).
          const indent = " ".repeat(
            block.type === "numbered_list_item" ? 3 : 2
          );
          const indented = nested
            .split("\n")
            .map((line) => (line ? `${indent}${line}` : line))
            .join("\n");
          return `${leaf}\n${indented}`;
        }
        // Other leaves (paragraph, quote) keep their children as following
        // sibling blocks — the indentation semantics are lost but the content
        // survives.
        return `${leaf}\n\n${nested}`;
      })
    );
    // Join with a blank line, except between consecutive list items, which stay
    // tight so they render as a single list rather than separate loose ones.
    const pairs = blocks.flatMap((block, i) => {
      const text = parts[i] ?? "";
      return text ? [{ block, text }] : [];
    });
    return pairs
      .map((pair, i) => {
        if (i === 0) {
          return pair.text;
        }
        const tight = isListItem(pairs[i - 1]?.block) && isListItem(pair.block);
        return `${tight ? "\n" : "\n\n"}${pair.text}`;
      })
      .join("");
  };

  const titleProperty = (page: NotionPage): NotionProperty | undefined => {
    if (props.title) {
      return page.properties[props.title];
    }
    return Object.values(page.properties).find((p) => p.type === "title");
  };

  const isDraft = (page: NotionPage): boolean => {
    const prop = page.properties[props.status ?? "Status"];
    const status = prop?.status?.name ?? prop?.select?.name;
    // A page without a Status/select property stays published; one with a
    // status is a draft unless it matches the published value.
    return Boolean(
      status && status !== (options.publishedValue ?? "Published")
    );
  };

  const orderOf = (page: NotionPage): number | undefined => {
    const order = page.properties[props.order ?? "Order"]?.number;
    return order === null ? undefined : order;
  };

  const frontmatter = (page: NotionPage) => {
    const data: NotionFrontmatter = {};
    // Frontmatter holds plain text: Markdown marks or escapes would show.
    const title = richToPlain(titleProperty(page)?.title);
    if (title) {
      data.title = title;
    }
    const description = richToPlain(
      page.properties[props.description ?? "Description"]?.rich_text
    );
    if (description) {
      data.description = description;
    }
    if (isDraft(page)) {
      data.draft = true;
    }
    const order = orderOf(page);
    if (order !== undefined) {
      data.sidebar = { order };
    }
    const slugProp = richToPlain(
      page.properties[props.slug ?? "Slug"]?.rich_text
    );
    // A Slug property is path-aware: `guides/setup` keeps its `/` (per-segment
    // slugging) instead of mashing into `guidessetup`. A title is one name, so
    // its slashes become hyphens: "CI/CD Setup" routes to `ci-cd-setup`, not
    // to `cd-setup` inside an invented `ci` group.
    const slug =
      (slugProp
        ? slugifyPath(slugProp)
        : slugify(title.replaceAll("/", "-"))) || page.id;
    return { data, slug };
  };

  const toEntry = async (
    client: NotionClientLike,
    page: NotionPage
  ): Promise<{ entry: SourceEntry; diagnostics: Diagnostic[] }> => {
    const { data, slug } = frontmatter(page);
    const mdx = await renderBlocks(client, await childrenOf(client, page.id));
    const assets = await materializeAssets(mdx, {
      assetsBaseUrl,
      assetsDir,
      fetchImpl: options.fetchImpl,
      inFlight,
      limit: downloads,
    });
    const raw = matter.stringify(assets.markdown, data);
    return {
      diagnostics: assets.diagnostics,
      entry: {
        body: { format: "mdx", text: assets.markdown },
        data,
        hash: hashText(raw),
        lastModified: page.last_edited_time,
        raw,
        ref: `${slug}.mdx`,
      },
    };
  };

  // A database's rows live in its data source (API 2025-09-03). Blume reads
  // the first one, which is the only one a database created in Notion has.
  const resolveDataSource = async (
    client: NotionClientLike
  ): Promise<string> => {
    const database = await notionCall(() =>
      client.databases.retrieve({ database_id: options.database })
    );
    const [dataSource] = database.data_sources;
    if (!dataSource) {
      throw new BlumeError({
        code: "BLUME_SOURCE_MISCONFIGURED",
        message: `Source "${options.name}": Notion database "${options.database}" has no data source to read pages from.`,
        severity: "error",
      });
    }
    return dataSource.id;
  };

  // Hoisted out of `load` so the retry closure doesn't nest past the linter's
  // 4-level limit (source factory → queryDataSource → notionCall callback).
  const queryDataSource = (
    client: NotionClientLike,
    dataSourceId: string,
    cursor?: string
  ): Promise<NotionList<NotionPage>> =>
    notionCall(() =>
      client.dataSources.query({
        data_source_id: dataSourceId,
        start_cursor: cursor,
      })
    );

  const load = async (
    refresh = ctx?.refresh ?? true
  ): Promise<SourceLoadResult> => {
    const assetDiagnostics: Diagnostic[] = [];
    const result = await loadWithCache(
      options.name,
      cache,
      async () => {
        const client = resolveClient();
        const dataSourceId = await resolveDataSource(client);
        const pages = await collectAll((cursor) =>
          queryDataSource(client, dataSourceId, cursor)
        );
        const built = await Promise.all(
          pages.map((page) => toEntry(client, page))
        );
        for (const item of built) {
          assetDiagnostics.push(...item.diagnostics);
        }
        return built.map((item) => item.entry);
      },
      refresh
    );
    snapshot = new Map(result.entries.map((entry) => [entry.ref, entry]));
    return {
      diagnostics: [...result.diagnostics, ...assetDiagnostics],
      entries: result.entries,
    };
  };

  const read = async (ref: string): Promise<string> => {
    const cached = snapshot.get(ref);
    if (cached) {
      return cached.raw ?? cached.body.text;
    }
    const all = await cache.read();
    return all.find((e) => e.ref === ref)?.raw ?? "";
  };

  return {
    load,
    name: options.name,
    prefix: options.prefix,
    read,
    staged: true,
    watch: options.pollInterval
      ? pollingWatch(
          () => load(true),
          options.pollInterval,
          () => load()
        )
      : undefined,
    withContext: (next) => notionSource(options, next),
  };
};
