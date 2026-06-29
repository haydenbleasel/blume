import matter from "gray-matter";
import { join } from "pathe";

import { BlumeError } from "../diagnostics.ts";
import type { Diagnostic } from "../types.ts";
import { materializeAssets } from "./assets.ts";
import {
  hashText,
  loadWithCache,
  pollingWatch,
  snapshotCache,
} from "./cache.ts";
import { slugify } from "./normalize.ts";
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

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
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
  /** Integration token; defaults to `NOTION_TOKEN`. */
  token?: string;
  properties?: NotionPropertyMap;
  /**
   * When set, the `Status` property is treated as a publish signal: any value
   * other than this maps to `draft: true`. Omit to import every page regardless
   * of status (the safe default for databases that use Status for an editorial
   * workflow rather than publishing).
   */
  publishedValue?: string;
  /** Opt-in dev polling interval (seconds); omit to freeze for the session. */
  pollInterval?: number;
  /** Injected for tests; otherwise built from `@notionhq/client`. */
  client?: NotionClientLike;
  /** Injected for tests; used to download images. */
  fetchImpl?: typeof fetch;
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

const blockField = (block: NotionBlock): NotionRichText[] =>
  ((block[block.type] as { rich_text?: NotionRichText[] })?.rich_text ??
    []) as NotionRichText[];

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
  const data = (block[block.type] ?? {}) as Record<string, unknown>;
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
      return `\`\`\`${(data.language as string) ?? ""}\n${text}\n\`\`\``;
    }
    case "image": {
      const media = data as {
        external?: { url: string };
        file?: { url: string };
        caption?: NotionRichText[];
      };
      const url = media.external?.url ?? media.file?.url;
      return url ? `![${richToMarkdown(media.caption)}](${url})` : "";
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
      client.blocks.children.list({ block_id: blockId, start_cursor: cursor })
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
      blocks.map(
        (block) =>
          renderLeaf(block) ?? renderContainer(client, block, renderBlocks)
      )
    );
    // Join with a blank line, except between consecutive list items, which stay
    // tight so they render as a single list rather than separate loose ones.
    const pairs = blocks
      .map((block, i) => ({ block, text: parts[i] ?? "" }))
      .filter((pair) => pair.text);
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
    if (!options.publishedValue) {
      return false;
    }
    const prop = page.properties[props.status ?? "Status"];
    const status = prop?.status?.name ?? prop?.select?.name;
    return Boolean(status && status !== options.publishedValue);
  };

  const orderOf = (page: NotionPage): number | undefined => {
    const order = page.properties[props.order ?? "Order"]?.number;
    return typeof order === "number" ? order : undefined;
  };

  const frontmatter = (
    page: NotionPage
  ): { data: Record<string, unknown>; slug: string } => {
    const data: Record<string, unknown> = {};
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
    const slug = slugify(slugProp || title) || page.id;
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

  const load = async (): Promise<SourceLoadResult> => {
    const assetDiagnostics: Diagnostic[] = [];
    const result = await loadWithCache(
      options.name,
      cache,
      async () => {
        const client = await resolveClient();
        const pages = await collectAll((cursor) =>
          client.databases.query({
            database_id: options.database,
            start_cursor: cursor,
          })
        );
        const built = await Promise.all(
          pages.map((page) => toEntry(client, page))
        );
        for (const item of built) {
          assetDiagnostics.push(...item.diagnostics);
        }
        return built.map((item) => item.entry);
      },
      ctx?.refresh ?? true
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
      ? pollingWatch(load, options.pollInterval)
      : undefined,
  };
};
