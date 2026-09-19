import { describe, expect, it } from "bun:test";

import { blumeConfigSchema } from "../src/core/schema.ts";

/**
 * The 2.0 config cleanups: each removed or renamed field fails validation with
 * a hint that names its replacement, and the replacement shapes resolve as
 * documented.
 */

const parse = blumeConfigSchema.safeParse.bind(blumeConfigSchema);

/** Every issue message of a failed parse, so a hint can be asserted on. */
const messages = (
  result: ReturnType<typeof blumeConfigSchema.safeParse>
): string[] => {
  expect(result.success).toBe(false);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("theme.layout", () => {
  it("rejects the removed field with a hint", () => {
    expect(messages(parse({ theme: { layout: "sidebar" } }))).toEqual([
      "theme.layout was removed: the sidebar layout is the only one, so delete the field.",
    ]);
  });

  it("keeps the default message for a key that never existed", () => {
    expect(messages(parse({ theme: { colour: "teal" } }))[0]).toMatch(
      /Unrecognized key/u
    );
  });

  it("keeps Zod's own message when the block itself is the wrong type", () => {
    // The hint only speaks to unrecognized keys; a non-object `theme` reports
    // the standard type error.
    expect(messages(parse({ theme: "compact" }))[0]).toMatch(
      /expected object/iu
    );
  });
});

describe("markdown.code", () => {
  it("rejects markdown.codeBlocks with a hint pointing at markdown.code", () => {
    expect(
      messages(
        parse({ markdown: { codeBlocks: { theme: { dark: "vesper" } } } })
      )
    ).toEqual([
      "markdown.codeBlocks was merged into markdown.code: move theme: { light, dark } under markdown.code.",
    ]);
  });

  it("resolves the merged shape with defaults", () => {
    expect(blumeConfigSchema.parse({}).markdown.code).toStrictEqual({
      icons: true,
      theme: { dark: "github-dark", light: "github-light" },
      wrap: false,
    });
  });

  it("accepts icons, wrap, and the theme pair together", () => {
    expect(
      blumeConfigSchema.parse({
        markdown: {
          code: { icons: false, theme: { dark: "vesper" }, wrap: true },
        },
      }).markdown.code
    ).toStrictEqual({
      icons: false,
      theme: { dark: "vesper", light: "github-light" },
      wrap: true,
    });
  });
});

describe("lastModified", () => {
  const HINT =
    'lastModified takes false, "git", or "frontmatter": `true` became "git" and `{ type: "…" }` became the bare string.';

  it("defaults to false", () => {
    expect(blumeConfigSchema.parse({}).lastModified).toBe(false);
  });

  it("accepts each of the three values", () => {
    for (const value of [false, "git", "frontmatter"] as const) {
      expect(
        blumeConfigSchema.parse({ lastModified: value }).lastModified
      ).toBe(value);
    }
  });

  it("rejects true and the object form with the hint", () => {
    for (const value of [true, { type: "git" }, { type: "frontmatter" }]) {
      const result = parse({ lastModified: value });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]).toMatchObject({
          message: HINT,
          path: ["lastModified"],
        });
      }
    }
  });
});

describe("agents", () => {
  const MOVED = [
    "api",
    "catalog",
    "llmsTxt",
    "markdownComponents",
    "mcp",
    "skills",
    "webBotAuth",
    "webmcp",
  ];

  it("rejects each key that moved out of ai with a hint naming its new home", () => {
    for (const key of MOVED) {
      expect(messages(parse({ ai: { [key]: true } }))).toEqual([
        `ai.${key} moved to agents.${key}.`,
      ]);
    }
  });

  it("lists every moved key in one message when several are still under ai", () => {
    expect(
      messages(
        parse({ ai: { llmsTxt: true, mcp: { enabled: true }, skills: "x" } })
      )
    ).toEqual([
      "ai.llmsTxt moved to agents.llmsTxt. ai.mcp moved to agents.mcp. ai.skills moved to agents.skills.",
    ]);
  });

  it("rejects the two keys that moved out of seo with hints", () => {
    expect(messages(parse({ seo: { agentReadability: false } }))).toEqual([
      "seo.agentReadability moved to agents.agentReadability.",
    ]);
    expect(messages(parse({ seo: { contentSignals: false } }))).toEqual([
      "seo.contentSignals moved to agents.contentSignals.",
    ]);
  });

  it("keeps ask and openInChat under ai", () => {
    const { ai } = blumeConfigSchema.parse({
      ai: { ask: { enabled: true }, openInChat: ["claude"] },
    });
    expect(ai.ask?.enabled).toBe(true);
    expect(ai.openInChat).toEqual(["claude"]);
    expect(Object.keys(ai).toSorted()).toEqual(["ask", "openInChat"]);
  });

  it("resolves the agents defaults", () => {
    expect(blumeConfigSchema.parse({}).agents).toStrictEqual({
      agentReadability: true,
      api: true,
      catalog: { enabled: true, queries: {} },
      contentSignals: { aiInput: true, aiTrain: true, search: true },
      llmsTxt: { enabled: true, openapi: true },
      markdownComponents: {},
      mcp: { enabled: false, route: "/mcp" },
      webBotAuth: { keys: [] },
      webmcp: true,
    });
  });

  it("reads the moved keys under agents", () => {
    const { agents } = blumeConfigSchema.parse({
      agents: {
        agentReadability: false,
        api: false,
        contentSignals: { aiTrain: false },
        llmsTxt: { openapi: false },
        mcp: { enabled: true, route: "docs-mcp" },
        skills: "./skills",
        webmcp: false,
      },
    });
    expect(agents).toMatchObject({
      agentReadability: false,
      api: false,
      contentSignals: { aiInput: true, aiTrain: false, search: true },
      llmsTxt: { enabled: true, openapi: false },
      mcp: { enabled: true, route: "/docs-mcp" },
      skills: "./skills",
      webmcp: false,
    });
  });

  it("rejects a model-facing key placed under agents with the default message", () => {
    expect(messages(parse({ agents: { ask: { enabled: true } } }))[0]).toMatch(
      /Unrecognized key/u
    );
  });
});
