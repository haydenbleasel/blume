import { describe, expect, it } from "bun:test";

import type { McpData } from "../src/ai/mcp/data.ts";
import {
  buildMcpDiscovery,
  buildMcpServerCard,
} from "../src/ai/mcp/discovery.ts";
import { createMcpFetchHandler } from "../src/ai/mcp/server.ts";
import { MCP_TOOLS } from "../src/ai/mcp/tools.ts";
import { buildOramaIndex, queryOramaIndex } from "../src/search/orama-index.ts";

const DATA: McpData = {
  documents: [
    {
      content:
        "Install Blume with your package manager, then run the dev server to preview the docs.",
      description: "How to install Blume",
      route: "/guides/install",
      title: "Installation",
    },
    {
      content:
        "Configure themes, navigation, and search in blume.config.ts to customize the site.",
      description: "Configuration reference",
      route: "/guides/config",
      title: "Configuration",
    },
  ],
  name: "Test Docs",
  navigation: {
    chromeVariants: [],
    selectors: [],
    sidebar: [
      {
        kind: "page",
        label: "Installation",
        pageId: "guides/install",
        route: "/guides/install",
      },
    ],
    sidebarVariants: [],
    tabs: [{ label: "Guides", path: "/guides/install" }],
  },
  pages: {
    "/guides/config":
      "---\ntitle: Configuration\n---\n# Configuration\n\nConfigure it.",
    "/guides/install":
      "---\ntitle: Installation\n---\n# Installation\n\nInstall it.",
  },
  routes: [
    {
      contentType: "doc",
      description: "How to install Blume",
      indexable: true,
      lastModified: null,
      route: "/guides/install",
      title: "Installation",
    },
    {
      contentType: "doc",
      description: "Configuration reference",
      indexable: true,
      lastModified: null,
      route: "/guides/config",
      title: "Configuration",
    },
  ],
  site: "https://docs.example.com",
  version: "0.0.0",
};

const handler = createMcpFetchHandler(DATA);

const post = (method: string, params?: unknown): Promise<Response> =>
  handler(
    new Request("https://docs.example.com/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    })
  );

const rpc = async (method: string, params?: unknown) => {
  const response = await post(method, params);
  return (await response.json()) as {
    error?: { message: string };
    result?: Record<string, unknown>;
  };
};

const callTool = async (name: string, args?: Record<string, unknown>) => {
  const body = await rpc("tools/call", { arguments: args, name });
  const content = body.result?.content as { text: string }[] | undefined;
  return {
    isError: body.result?.isError === true,
    text: content?.[0]?.text ?? "",
  };
};

describe("createMcpFetchHandler transport", () => {
  it("answers CORS preflight without a body", async () => {
    const response = await handler(
      new Request("https://docs.example.com/mcp", { method: "OPTIONS" })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects GET (no server-initiated streams)", async () => {
    const response = await handler(
      new Request("https://docs.example.com/mcp", { method: "GET" })
    );
    expect(response.status).toBe(405);
  });

  it("lists every registered tool", async () => {
    const body = await rpc("tools/list");
    const tools = (body.result?.tools as { name: string }[]) ?? [];
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      MCP_TOOLS.map((tool) => tool.name).toSorted()
    );
  });
});

describe("MCP tools", () => {
  it("search_docs ranks the relevant page first with an absolute URL", async () => {
    const { text, isError } = await callTool("search_docs", {
      query: "install dev server",
    });
    expect(isError).toBe(false);
    const hits = JSON.parse(text) as { url: string }[];
    expect(hits[0]?.url).toBe("https://docs.example.com/guides/install");
  });

  it("search_docs honours the limit", async () => {
    const { text } = await callTool("search_docs", {
      limit: 1,
      query: "blume",
    });
    expect((JSON.parse(text) as unknown[]).length).toBe(1);
  });

  it("get_page returns the raw Markdown source", async () => {
    const { text, isError } = await callTool("get_page", {
      route: "/guides/install",
    });
    expect(isError).toBe(false);
    expect(text).toContain("# Installation");
  });

  it("get_page normalizes a .md suffix and trailing slash", async () => {
    const { text } = await callTool("get_page", {
      route: "/guides/install.md/",
    });
    expect(text).toContain("# Installation");
  });

  it("get_page reports an error for an unknown route", async () => {
    const { isError } = await callTool("get_page", { route: "/nope" });
    expect(isError).toBe(true);
  });

  it("list_pages returns every non-hidden route", async () => {
    const { text } = await callTool("list_pages");
    const routes = JSON.parse(text) as { route: string }[];
    expect(routes.map((route) => route.route).toSorted()).toEqual([
      "/guides/config",
      "/guides/install",
    ]);
  });

  it("get_navigation returns the navigation tree", async () => {
    const { text } = await callTool("get_navigation");
    const nav = JSON.parse(text) as { tabs: unknown[] };
    expect(nav.tabs.length).toBe(1);
  });
});

describe("orama index helpers", () => {
  it("ranks a title match above a body-only match", async () => {
    const db = await buildOramaIndex(DATA.documents);
    const hits = await queryOramaIndex(db, "configuration", 5);
    expect(hits[0]?.route).toBe("/guides/config");
  });

  it("filters results to a locale when one is given", async () => {
    const db = await buildOramaIndex([
      {
        content: "Installation guide",
        description: "",
        locale: "en",
        route: "/install",
        title: "Install",
      },
      {
        content: "Guide d'installation",
        description: "",
        locale: "fr",
        route: "/fr/install",
        title: "Installation",
      },
    ]);
    const fr = await queryOramaIndex(db, "install", 5, "fr");
    expect(fr.map((doc) => doc.route)).toEqual(["/fr/install"]);
    // No filter searches every language.
    const all = await queryOramaIndex(db, "install", 5);
    expect(all.length).toBe(2);
  });
});

describe("discovery documents", () => {
  const input = {
    name: "Test Docs",
    route: "/mcp",
    site: "https://docs.example.com",
    version: "0.0.0",
  };

  it("advertises the absolute server URL", () => {
    const discovery = buildMcpDiscovery(input) as {
      servers: { url: string }[];
    };
    expect(discovery.servers[0]?.url).toBe("https://docs.example.com/mcp");
  });

  it("lists the tool set in the server card", () => {
    const card = buildMcpServerCard(input) as { tools: { name: string }[] };
    expect(card.tools.map((tool) => tool.name).toSorted()).toEqual(
      MCP_TOOLS.map((tool) => tool.name).toSorted()
    );
  });

  it("falls back to a relative URL without a site", () => {
    const discovery = buildMcpDiscovery({ ...input, site: null }) as {
      servers: { url: string }[];
    };
    expect(discovery.servers[0]?.url).toBe("/mcp");
  });
});
