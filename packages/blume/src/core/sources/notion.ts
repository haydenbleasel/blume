import { setTimeout as sleep } from "node:timers/promises";

import pLimit from "p-limit";
import { join } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import matter from "../frontmatter.ts";
import type { Diagnostic } from "../types.ts";
import { materializeAssets } from "./assets.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import { slugifyPath } from "./normalize.ts";
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

/** The slice of `@notionhq/client` this adapter relies on (so it's mockable). */
export interface NotionClientLike {
  databases: {
    query: (args: {
      database_id: string;
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

const richToMarkdown = (rich: NotionRichText[] = []): string =>
  rich
    .map((node) => {
      let text = node.plain_text;
      if (node.annotations?.code) {
        text = `\`${text}\``;
      }
      if (node.annotations?.bold) {
        text = `**${text}**`;
      }
      if (node.annotations?.italic) {
        text = `*${text}*`;
      }
      if (node.annotations?.strikethrough) {
        text = `~~${text}~~`;
      }
      return node.href ? `[${text}](${node.href})` : text;
    })
    .join("");

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
    // SAFETY: same APIResponseError shape — `headers` maps lower-cased HTTP
    // header names to their values; a missing header yields `NaN` and falls
    // back to exponential backoff.
    const retryAfter = Number(
      (error as { headers?: Record<string, string> }).headers?.["retry-after"]
    );
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

/** Render a leaf (non-container) block to Markdown, or null for containers. */
const renderLeaf = (block: NotionBlock): string | null => {
  const data = payloadOf(block) ?? {};
  const text = richToMarkdown(blockField(block));
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
      return `\`\`\`${data.language ?? ""}\n${text}\n\`\`\``;
    }
    case "image": {
      const url = data.external?.url ?? data.file?.url;
      return url ? `![${richToMarkdown(data.caption)}](${url})` : "";
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

  const resolveClient = async (): Promise<NotionClientLike> => {
    if (options.client) {
      return options.client;
    }
    let Client: new (config: { auth?: string }) => NotionClientLike;
    try {
      // SAFETY: `@notionhq/client` exports a `Client` class constructable with
      // an `auth` token whose instances cover the NotionClientLike slice; the
      // local type keeps the SDK mockable without importing its types.
      ({ Client } = (await import("@notionhq/client")) as {
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
      const body = [richToMarkdown(blockField(block)), await children(block)]
        .filter(Boolean)
        .join("\n\n");
      return `<Callout>\n${body}\n</Callout>`;
    }
    if (block.type === "toggle") {
      const title = JSON.stringify(richToMarkdown(blockField(block)));
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
    const title = richToMarkdown(titleProperty(page)?.title);
    if (title) {
      data.title = title;
    }
    const description = richToMarkdown(
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
    const slugProp = richToMarkdown(
      page.properties[props.slug ?? "Slug"]?.rich_text
    );
    // Path-aware: a `guides/setup` slug keeps its `/` (per-segment slugging)
    // instead of mashing into `guidessetup`.
    const slug = slugifyPath(slugProp || title) || page.id;
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

  // Hoisted out of `load` so the retry closure doesn't nest past the linter's
  // 4-level limit (source factory → queryDatabase → notionCall callback).
  const queryDatabase = (
    client: NotionClientLike,
    cursor?: string
  ): Promise<NotionList<NotionPage>> =>
    notionCall(() =>
      client.databases.query({
        database_id: options.database,
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
        const client = await resolveClient();
        const pages = await collectAll((cursor) =>
          queryDatabase(client, cursor)
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
  };
};
