import { describe, expect, it } from "bun:test";

import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";

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

  it("keeps reporting a plain unknown key beside a moved one", () => {
    expect(messages(parse({ ai: { colour: "teal", llmsTxt: true } }))).toEqual([
      'ai.llmsTxt moved to agents.llmsTxt. Unrecognized key: "colour"',
    ]);
    expect(
      messages(parse({ ai: { colour: "teal", llmsTxt: true, size: 1 } }))
    ).toEqual([
      'ai.llmsTxt moved to agents.llmsTxt. Unrecognized keys: "colour", "size"',
    ]);
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

  it("keeps assistant and openInChat under ai", () => {
    const { ai } = blumeConfigSchema.parse({
      ai: { assistant: { enabled: true }, openInChat: ["claude"] },
    });
    expect(ai.assistant?.enabled).toBe(true);
    expect(ai.openInChat).toEqual(["claude"]);
    expect(Object.keys(ai).toSorted()).toEqual(["assistant", "openInChat"]);
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
      skillMd: true,
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
    expect(
      messages(parse({ agents: { assistant: { enabled: true } } }))[0]
    ).toMatch(/Unrecognized key/u);
  });
});

describe("ai.assistant provider", () => {
  /** An inline `blume/ai` descriptor, as the factories return it. */
  const inkeepDescriptor = {
    kind: "inkeep",
    options: { model: "inkeep-qa" },
    requiredSecrets: [],
    runtimeDeps: [],
  };

  it("names the factory that replaced a 1.x provider name", () => {
    expect(
      messages(parse({ ai: { assistant: { provider: "openrouter" } } }))
    ).toEqual([
      'ai.assistant.provider takes an adapter from "blume/ai", not a provider name: `provider: openrouter({ model })`. The 1.x model, apiKeyEnv, baseUrl, headers, and reasoning fields move into the call.',
    ]);
    expect(
      messages(
        parse({ ai: { assistant: { provider: "openai-compatible" } } })
      )[0]
    ).toContain("`provider: openaiCompatible({ model })`");
  });

  it("lists the adapters for a provider value that was never a 1.x name", () => {
    const hint =
      'ai.assistant.provider takes an adapter from "blume/ai": gateway(), openrouter(), llmgateway(), inkeep(), or openaiCompatible().';
    expect(
      messages(parse({ ai: { assistant: { provider: "anthropic" } } }))
    ).toEqual([hint]);
    expect(messages(parse({ ai: { assistant: { provider: 42 } } }))).toEqual([
      hint,
    ]);
  });

  it("keeps Zod's message for a descriptor with an unknown kind", () => {
    expect(
      messages(parse({ ai: { assistant: { provider: { kind: "nope" } } } }))[0]
    ).toMatch(/discriminator/iu);
  });

  it("moves the 1.x flat fields into the adapter the provider names", () => {
    expect(
      messages(
        parse({
          ai: {
            assistant: {
              model: "anthropic/claude-sonnet-4-5",
              provider: "openrouter",
              reasoning: "none",
            },
          },
        })
      )
    ).toEqual([
      'ai.assistant.provider takes an adapter from "blume/ai", not a provider name: `provider: openrouter({ model })`. The 1.x model, apiKeyEnv, baseUrl, headers, and reasoning fields move into the call.',
      'ai.assistant.model, ai.assistant.reasoning moved into the provider adapter: `provider: openrouter({ model, reasoning })`, imported from "blume/ai".',
    ]);
  });

  it("names the descriptor's own adapter, or the gateway when unset", () => {
    expect(
      messages(
        parse({ ai: { assistant: { model: "x", provider: inkeepDescriptor } } })
      )
    ).toEqual([
      'ai.assistant.model moved into the provider adapter: `provider: inkeep({ model })`, imported from "blume/ai".',
    ]);
    expect(
      messages(parse({ ai: { assistant: { apiKeyEnv: "KEY", headers: {} } } }))
    ).toEqual([
      'ai.assistant.apiKeyEnv, ai.assistant.headers moved into the provider adapter: `provider: gateway({ apiKeyEnv, headers })`, imported from "blume/ai".',
    ]);
  });

  it("keeps reporting a plain unknown key beside a moved field", () => {
    expect(
      messages(
        parse({ ai: { assistant: { baseUrl: "https://x.dev", colour: 1 } } })
      )
    ).toEqual([
      'ai.assistant.baseUrl moved into the provider adapter: `provider: gateway({ baseUrl })`, imported from "blume/ai". Unrecognized key: "colour"',
    ]);
  });

  it("keeps the default message for an unknown key alone", () => {
    expect(messages(parse({ ai: { assistant: { colour: 1 } } }))[0]).toMatch(
      /^Unrecognized key/u
    );
  });

  it("keeps Zod's own message when ai.assistant isn't an object", () => {
    expect(messages(parse({ ai: { assistant: "yes" } }))[0]).toMatch(
      /expected object/iu
    );
  });
});

describe("ai.ask", () => {
  it("rejects the old key with a hint naming ai.assistant", () => {
    expect(messages(parse({ ai: { ask: { enabled: true } } }))).toEqual([
      "ai.ask was renamed to ai.assistant.",
    ]);
  });

  it("rejects the old UI string keys with hints naming their new ones", () => {
    const result = parse({
      i18n: {
        locales: [{ code: "en", label: "English" }],
        ui: {
          en: {
            ask: { title: "Chat" },
            search: { askAi: "Chat", askAiHint: "Ask the docs", button: "Go" },
          },
        },
      },
    });
    expect(messages(result)).toEqual([
      "i18n.ui.en.ask was renamed to i18n.ui.en.assistant.",
      "i18n.ui.en.search.askAi was renamed to i18n.ui.en.search.assistant.",
      "i18n.ui.en.search.askAiHint was renamed to i18n.ui.en.search.assistantHint.",
    ]);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["i18n", "ui", "en", "ask"],
      ["i18n", "ui", "en", "search", "askAi"],
      ["i18n", "ui", "en", "search", "askAiHint"],
    ]);
  });

  it("accepts the renamed UI string keys", () => {
    const result = parse({
      i18n: {
        locales: [{ code: "en", label: "English" }],
        ui: {
          en: {
            assistant: { title: "Chat" },
            search: { assistant: "Chat", assistantHint: "Ask the docs" },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("the 1.x reference blocks", () => {
  it("names the reference list beside every other issue in the config", () => {
    // The hint is part of the schema, not a pre-check: `lastModified: true`
    // is still reported in the same run.
    const found = messages(
      parse({ graphql: {}, lastModified: true, theme: { radius: "md" } })
    );
    expect(found).toHaveLength(2);
    expect(found.join("\n")).toContain(
      "The top-level `graphql` config was replaced by `reference`"
    );
    expect(found.join("\n")).toContain('`true` became "git"');
  });

  it("keeps reporting a plain unknown key beside the removed blocks", () => {
    const [message] = messages(parse({ colour: "teal", openapi: {} }));
    expect(message).toContain("`reference: [openapi({ … })]`");
    expect(message).toEndWith('Unrecognized key: "colour"');
  });
});

describe("search.boost frontmatter", () => {
  it("is a relevance multiplier again, not a removed field", () => {
    expect(pageMetaSchema.parse({ search: { boost: 2 } }).search.boost).toBe(2);
  });

  it("keeps the other search keys", () => {
    expect(
      pageMetaSchema.parse({ search: { exclude: true, tags: ["a"] } }).search
    ).toEqual({ exclude: true, tags: ["a"] });
  });
});
