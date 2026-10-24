import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { WebMcpTool } from "../src/components/islands/webmcp.ts";
import {
  buildWebMcpTools,
  registerWebMcpTools,
} from "../src/components/islands/webmcp.ts";
import type { SearchFn } from "../src/components/layout/search/types.ts";

const noSearch: () => Promise<SearchFn> = () =>
  Promise.reject(new Error("unused"));

const toolsWith = (
  overrides: Partial<Parameters<typeof buildWebMcpTools>[0]> = {}
): WebMcpTool[] =>
  buildWebMcpTools({
    base: "/base/",
    llms: true,
    loadSearch: noSearch,
    origin: "https://docs.test",
    search: true,
    skills: true,
    ...overrides,
  });

const tool = (tools: WebMcpTool[], name: string): WebMcpTool => {
  const found = tools.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`no tool ${name}`);
  }
  return found;
};

const okResponse = (body: string): Response =>
  new Response(body, { status: 200 });

/** Wrap a URL-only handler as the global `fetch` type the tools expect. */
const asFetch = (handler: (url: string) => Promise<Response>): typeof fetch =>
  // SAFETY: the tools invoke fetchFn with a single string URL and only read
  // the Response; the extra statics on Bun's fetch type (e.g. `preconnect`)
  // are never touched.
  handler as typeof fetch;

const hitSearch: SearchFn = () =>
  Promise.resolve({
    hits: [
      {
        excerpt: "Install <mark>Blume</mark> quickly.",
        title: "<mark>Install</mark>",
        url: "/quickstart",
      },
    ],
    sections: [],
  });

const emptySearch: SearchFn = () => Promise.resolve({ hits: [], sections: [] });

const mangledSearch: SearchFn = () =>
  Promise.resolve({
    hits: [
      {
        excerpt: "Mangled <scr<b>ipt>alert(1)</script> and dangling <img src=x",
        title: "Install",
        url: "/quickstart",
      },
    ],
    sections: [],
  });

describe("buildWebMcpTools", () => {
  it("offers the tool set, gated by the config flags", () => {
    expect(toolsWith().map((entry) => entry.name)).toEqual([
      "search_docs",
      "get_page",
      "list_pages",
      "read_skill",
      "navigate_page",
    ]);
    expect(
      toolsWith({ llms: false, search: false, skills: false }).map(
        (entry) => entry.name
      )
    ).toEqual(["get_page", "navigate_page"]);
    for (const entry of toolsWith()) {
      // Only navigation changes anything, and only the user's own tab.
      expect(entry.annotations).toEqual({
        openWorldHint: false,
        readOnlyHint: entry.name !== "navigate_page",
      });
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.inputSchema.type).toBe("object");
    }
  });

  it("search_docs strips markup, prefixes URLs, and retries a failed loader", async () => {
    let loads = 0;
    const search = tool(
      toolsWith({
        loadSearch: () => {
          loads += 1;
          return loads === 1
            ? Promise.reject(new Error("index offline"))
            : Promise.resolve(hitSearch);
        },
      }),
      "search_docs"
    );

    const blank = await search.execute({ query: "  " });
    expect(blank.isError).toBe(true);
    const failed = await search.execute({ query: "install" });
    expect(failed.isError).toBe(true);
    // The loader failure did not latch: the next call loads and succeeds.
    const result = await search.execute({ query: "install" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(
      "Install — /base/quickstart\nInstall Blume quickly."
    );
    const empty = await search.execute({ query: "zzz-no-hit" });
    // A working search with no matches is an answer, not an error.
    expect(empty.isError).toBeUndefined();
    expect(loads).toBe(2);
  });

  it("search_docs answers an empty result set without an error", async () => {
    const search = tool(
      toolsWith({ loadSearch: () => Promise.resolve(emptySearch) }),
      "search_docs"
    );

    const result = await search.execute({ query: "zzz" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('No results for "zzz".');
  });

  it("search_docs leaves no markup fragment behind on mangled hits", async () => {
    const search = tool(
      toolsWith({ loadSearch: () => Promise.resolve(mangledSearch) }),
      "search_docs"
    );

    const result = await search.execute({ query: "install" });
    // Lossy on broken markup by design — the guarantee is that no `<` (and
    // so no reassembled tag) survives.
    expect(result.content[0]?.text).toBe(
      "Install — /base/quickstart\nMangled ipt>alert(1) and dangling "
    );
    expect(result.content[0]?.text).not.toContain("<");
  });

  it("get_page fetches the based .md mirror and maps the home route", async () => {
    const fetched: string[] = [];
    const fetchFn = asFetch((url) => {
      fetched.push(url);
      return Promise.resolve(okResponse(`# page at ${url}\n`));
    });
    const getPage = tool(toolsWith({ fetchFn }), "get_page");

    const page = await getPage.execute({ route: "/quickstart/" });
    expect(page.content[0]?.text).toContain("/base/quickstart.md");
    await getPage.execute({ route: "/" });
    expect(fetched).toEqual(["/base/quickstart.md", "/base/index.md"]);
    // Under a root base, `//host` would pass through unprefixed and fetch
    // another origin's Markdown; it must not be fetched at all.
    const rootPage = tool(toolsWith({ base: "/", fetchFn }), "get_page");
    const offSite = await rootPage.execute({ route: "/\t/evil.test/x" });
    expect(offSite.isError).toBe(true);
    expect(fetched).toHaveLength(2);

    const relative = await getPage.execute({ route: "quickstart" });
    expect(relative.isError).toBe(true);
    const missing = tool(
      toolsWith({
        fetchFn: asFetch(() =>
          Promise.resolve(new Response("nope", { status: 404 }))
        ),
      }),
      "get_page"
    );
    const gone = await missing.execute({ route: "/gone" });
    expect(gone.isError).toBe(true);
    const offline = tool(
      toolsWith({
        fetchFn: asFetch(() => Promise.reject(new Error("offline"))),
      }),
      "get_page"
    );
    const down = await offline.execute({ route: "/x" });
    expect(down.isError).toBe(true);
  });

  it("list_pages returns llms.txt from the deployment base", async () => {
    const fetched: string[] = [];
    const fetchFn = asFetch((url) => {
      fetched.push(url);
      return Promise.resolve(okResponse("# Docs\n- [A](/a)\n"));
    });
    const list = tool(toolsWith({ fetchFn }), "list_pages");
    const result = await list.execute({});
    expect(fetched).toEqual(["/base/llms.txt"]);
    expect(result.content[0]?.text).toContain("- [A](/a)");

    const missing = tool(
      toolsWith({
        fetchFn: asFetch(() =>
          Promise.resolve(new Response("", { status: 404 }))
        ),
      }),
      "list_pages"
    );
    const gone = await missing.execute({});
    expect(gone.isError).toBe(true);
    const offline = tool(
      toolsWith({
        fetchFn: asFetch(() => Promise.reject(new Error("offline"))),
      }),
      "list_pages"
    );
    const down = await offline.execute({});
    expect(down.isError).toBe(true);
  });

  it("read_skill lists skills, reads a SKILL.md, and points at archives", async () => {
    const index = JSON.stringify({
      skills: [
        {
          description: "Use the docs.",
          name: "docs",
          type: "skill-md",
          url: "/base/.well-known/agent-skills/docs/SKILL.md",
        },
        {
          description: "Migrate.",
          digest: "sha256:abc",
          name: "migrate",
          type: "archive",
          url: "/base/.well-known/agent-skills/migrate.tar.gz",
        },
        // Relative URLs resolve against the index, absolute same-origin
        // ones are kept.
        { name: "relative", type: "archive", url: "relative.tar.gz" },
        {
          name: "absolute",
          type: "skill-md",
          url: "https://docs.test/base/absolute.md",
        },
        { name: "broken", type: "skill-md", url: "/base/missing.md" },
        { name: "offline", type: "skill-md", url: "/base/offline.md" },
        // Skipped: nothing the tool can hand over, or off this site.
        null,
        ["docs"],
        { description: "No name." },
        { description: "No URL.", name: "no-url", type: "skill-md" },
        { name: "no-type", url: "/base/no-type.md" },
        { name: "odd-type", type: "zip", url: "/base/odd.zip" },
        { name: "odd-url", type: "skill-md", url: { href: "/base/a.md" } },
        { name: "off-site", type: "skill-md", url: "https://evil.test/a.md" },
        { name: "sneaky", type: "skill-md", url: "/\\evil.test/a.md" },
        {
          description: { en: "x" },
          name: "odd-description",
          type: "skill-md",
          url: "/base/odd.md",
        },
      ],
    });
    const files = new Map([
      ["/base/.well-known/agent-skills/index.json", index],
      ["/base/.well-known/agent-skills/docs/SKILL.md", "# Docs skill\n"],
      ["/base/absolute.md", "# Absolute skill\n"],
    ]);
    const fetched: string[] = [];
    const fetchFn = asFetch((url) => {
      fetched.push(url);
      if (url === "/base/offline.md") {
        return Promise.reject(new Error("offline"));
      }
      const body = files.get(url);
      return Promise.resolve(
        body === undefined
          ? new Response("", { status: 404 })
          : okResponse(body)
      );
    });
    const read = tool(toolsWith({ fetchFn }), "read_skill");

    const [
      listed,
      docs,
      archive,
      relative,
      absolute,
      unknown,
      noUrl,
      broken,
      offline,
    ] = await Promise.all(
      [
        {},
        { name: "docs" },
        { name: "migrate" },
        { name: "relative" },
        { name: "absolute" },
        { name: "nope" },
        { name: "no-url" },
        { name: "broken" },
        { name: "offline" },
      ].map((input) => read.execute(input))
    );
    expect(listed?.isError).toBeUndefined();
    expect(listed?.content[0]?.text).toBe(
      "docs — Use the docs.\nmigrate — Migrate.\nrelative\nabsolute\nbroken\noffline\nodd-description"
    );
    expect(docs?.content[0]?.text).toBe("# Docs skill\n");
    expect(absolute?.content[0]?.text).toBe("# Absolute skill\n");
    // An archive isn't an error: the agent gets the absolute URL to download
    // and the digest to check it against.
    expect(archive?.isError).toBeUndefined();
    expect(archive?.content[0]?.text).toBe(
      '"migrate" is an archive skill: download https://docs.test/base/.well-known/agent-skills/migrate.tar.gz and unpack it. Its digest is sha256:abc.'
    );
    expect(relative?.content[0]?.text).toBe(
      '"relative" is an archive skill: download https://docs.test/base/.well-known/agent-skills/relative.tar.gz and unpack it.'
    );
    expect(unknown?.isError).toBe(true);
    expect(unknown?.content[0]?.text).toBe(
      'No skill named "nope". Available: docs, migrate, relative, absolute, broken, offline, odd-description.'
    );
    // A skipped entry is neither listed nor readable.
    expect(noUrl?.isError).toBe(true);
    expect(broken?.isError).toBe(true);
    expect(offline?.isError).toBe(true);
    // The index was fetched once for all nine calls, and nothing off-site.
    expect(fetched.filter((url) => url.endsWith("index.json"))).toHaveLength(1);
    expect(fetched.every((url) => url.startsWith("/base/"))).toBe(true);
  });

  it("read_skill reports no skills when the index is missing or malformed", async () => {
    const responses = [
      null,
      new Response("", { status: 404 }),
      okResponse("not json"),
      okResponse('{"skills":"docs"}'),
      okResponse('["docs"]'),
      okResponse('{"skills":[]}'),
    ];
    const results = await Promise.all(
      responses.map((response) =>
        tool(
          toolsWith({
            fetchFn: asFetch(() =>
              response
                ? Promise.resolve(response)
                : Promise.reject(new Error("offline"))
            ),
          }),
          "read_skill"
        ).execute({ name: "docs" })
      )
    );
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe(
        "This site publishes no agent skills."
      );
    }
  });

  it("read_skill refetches an index that failed to load", async () => {
    let calls = 0;
    const read = tool(
      toolsWith({
        fetchFn: asFetch(() => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(
                okResponse(
                  '{"skills":[{"name":"docs","type":"skill-md","url":"docs/SKILL.md"}]}'
                )
              );
        }),
      }),
      "read_skill"
    );

    const failed = await read.execute({});
    expect(failed.isError).toBe(true);
    const [retried, cached] = [await read.execute({}), await read.execute({})];
    expect(retried.content[0]?.text).toBe("docs");
    expect(cached.content[0]?.text).toBe("docs");
    expect(calls).toBe(2);
  });

  it("navigate_page opens based routes and refuses off-site targets", async () => {
    const visited: string[] = [];
    const go = tool(
      toolsWith({ navigate: (url) => visited.push(url) }),
      "navigate_page"
    );

    const result = await go.execute({ route: "/quickstart#install" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(
      "Navigating to /base/quickstart#install."
    );
    // A served URL `search_docs` returned keeps its base.
    await go.execute({ route: "/base/guide" });
    // The result is handed back before the tab starts to move.
    expect(visited).toEqual([]);
    const refused = await Promise.all(
      [
        "//evil.test",
        "/\\evil.test",
        "/\t/evil.test",
        "/\n\\evil.test",
        "https://evil.test",
        42,
      ].map((route) => go.execute({ route }))
    );
    expect(refused.map((entry) => entry.isError)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // Let the deferred navigation (`setTimeout(…, 0)`) run.
    await sleep(0);
    expect(visited).toEqual(["/base/quickstart#install", "/base/guide"]);
  });

  it("defaults to the page's location for navigation and the skills origin", async () => {
    const assigned: string[] = [];
    const fetched: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          assign: (url: string) => assigned.push(url),
          origin: "https://docs.test",
        },
      },
    });
    try {
      const tools = toolsWith({
        fetchFn: asFetch((url) => {
          fetched.push(url);
          return Promise.resolve(
            okResponse(
              '{"skills":[{"name":"docs","type":"archive","url":"https://docs.test/docs.tar.gz"},{"name":"other","type":"archive","url":"https://other.test/x.tar.gz"}]}'
            )
          );
        }),
        navigate: undefined,
        origin: undefined,
      });
      await tool(tools, "navigate_page").execute({ route: "/a" });
      await sleep(0);
      const listed = await tool(tools, "read_skill").execute({});
      // The other origin's archive is skipped against the page's own origin.
      expect(listed.content[0]?.text).toBe("docs");
    } finally {
      Reflect.deleteProperty(globalThis, "window");
    }
    expect(assigned).toEqual(["/base/a"]);
    expect(fetched).toEqual(["/base/.well-known/agent-skills/index.json"]);
  });
});

describe("registerWebMcpTools", () => {
  const tools = toolsWith({ llms: false, search: false, skills: false });

  it("prefers provideContext and falls back to registerTool", () => {
    const provided: unknown[] = [];
    expect(
      registerWebMcpTools(tools, {
        provideContext: (context) => provided.push(context),
      })
    ).toBe(true);
    expect(provided).toEqual([{ tools }]);

    const registered: unknown[] = [];
    expect(
      registerWebMcpTools(tools, {
        registerTool: (entry) => registered.push(entry),
      })
    ).toBe(true);
    expect(registered).toEqual(tools);
  });

  it("reports false when no model context surface exists", () => {
    expect(registerWebMcpTools(tools, null)).toBe(false);
    expect(registerWebMcpTools(tools)).toBe(false);
    expect(registerWebMcpTools(tools, {})).toBe(false);
  });
});
