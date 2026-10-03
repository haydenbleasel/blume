import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { parse, TextNode } from "node-html-parser";
import { dirname, join } from "pathe";

import { gateway, openai } from "../src/ai/ask.ts";
import type {
  AssistantGatewayOptions,
  AssistantOpenAIOptions,
} from "../src/ai/ask.ts";
import { scanProject } from "../src/core/project-graph.ts";
import {
  buildNarration,
  clipKey,
  gatewaySpeaker,
  htmlTree,
  missingKey,
  narrationCacheDir,
  openaiSpeaker,
  readPlayerPage,
} from "../src/narration/build.ts";
import { narrationProviderSchema } from "../src/narration/provider.ts";
import type {
  GatewayNarrationProvider,
  OpenAINarrationProvider,
} from "../src/narration/provider.ts";
import type { NarrationCues } from "../src/narration/script.ts";

/**
 * Tests for generated narration (`src/narration/build.ts`): reading built
 * pages, generating and caching a clip per sentence, and writing each page's
 * manifest. A fake speaker stands in for the speech model.
 */

const dirs: string[] = [];
const KEYS = [
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "VERCEL_OIDC_TOKEN",
  "NARRATION_TEST_KEY",
];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const CUES: NarrationCues = {
  danger: "Danger.",
  info: "Info.",
  note: "Note.",
  section: "Expandable section.",
  step: "Step {n}.",
  success: "Success.",
  tab: "{title} tab.",
  tip: "Tip.",
  warning: "Warning.",
};

const PROSE =
  "Narration reads this page from top to bottom. Each block is introduced with a short cue, so a listener knows what comes next. " +
  "The build generates one clip per sentence and caches it, so a rebuild only pays for sentences that changed. " +
  "Pages without enough prose to narrate get no player at all.";

/** A built page carrying the generated player, as the page template renders it. */
const page = (options: {
  base?: string;
  body?: string;
  cues?: string;
  lang?: string;
  manifest?: string | null;
  route: string;
}): string => {
  const base = options.base ?? "";
  const manifest =
    options.manifest === undefined
      ? `${base}/blume-narration${options.route}.json`
      : options.manifest;
  const attrs = [
    `data-audio-base="${base}/blume-narration/audio/"`,
    'data-blume-narration="skip"',
    "data-blume-narration-player",
    `data-cues='${options.cues ?? JSON.stringify(CUES)}'`,
    options.lang ? `data-lang="${options.lang}"` : "",
    manifest === null ? "" : `data-manifest="${manifest}"`,
  ].join(" ");
  return `<!doctype html><html><body><main id="blume-content"><article><h1>Title</h1><div ${attrs}><button>Listen</button></div>${
    options.body ?? `<aside data-blume-callout="tip"><p>${PROSE}</p></aside>`
  }</article></main></body></html>`;
};

/** A project on disk whose config enables generated narration, plus its dist. */
const fixture = async (
  config: string,
  pages: Record<string, string>
): Promise<{ dist: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "blume-narration-"));
  dirs.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "index.md"), "# Home\n", "utf-8");
  await writeFile(join(root, "blume.config.ts"), config, "utf-8");
  const dist = join(root, "dist");
  await Promise.all(
    Object.entries(pages).map(async ([path, html]) => {
      const target = join(dist, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, html, "utf-8");
    })
  );
  return { dist, root };
};

const PROVIDER_CONFIG = `export default {
  narration: {
    provider: {
      kind: "gateway",
      options: { apiKeyEnv: "NARRATION_TEST_KEY", voice: "nova" },
      requiredSecrets: ["NARRATION_TEST_KEY"],
      runtimeDeps: [],
    },
  },
};
`;

// What `openai({ baseUrl, model, voice })` returns, written out for a config.
const OPENAI_CONFIG = `export default {
  narration: {
    provider: {
      kind: "openai",
      options: { baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_heart" },
      requiredSecrets: ["OPENAI_API_KEY"],
      runtimeDeps: ["@ai-sdk/openai-compatible"],
    },
  },
};
`;

interface Log {
  info: string[];
  warn: string[];
}

const logger = (log: Log) => ({
  info: (message: string) => log.info.push(message),
  warn: (message: string) => log.warn.push(message),
});

/** A parsed `gateway()` narration provider. */
const gatewayProvider = (
  options?: AssistantGatewayOptions
): GatewayNarrationProvider => {
  const provider = narrationProviderSchema.parse(gateway(options));
  if (provider.kind !== "gateway") {
    throw new Error("expected a gateway() provider");
  }
  return provider;
};

/** A parsed `openai()` narration provider. */
const openaiProvider = (
  options: AssistantOpenAIOptions
): OpenAINarrationProvider => {
  const provider = narrationProviderSchema.parse(openai(options));
  if (provider.kind !== "openai") {
    throw new Error("expected an openai() provider");
  }
  return provider;
};

/** The JSON body of an OpenAI speech request. */
interface SpeechBody {
  input: string;
  instructions?: string;
  model: string;
  response_format: string;
  speed?: number;
  voice: string;
}

interface SpeechRequest {
  authorization: string | null;
  body: SpeechBody;
  headers: Headers;
  url: string;
}

/**
 * Run `task` against a fake OpenAI speech endpoint that answers every
 * request with `mp3!` as `contentType` (no type at all for `null`), returning
 * what it was sent. Fails on any warning the AI SDK would log, which it does
 * for every clip of an unsupported setting.
 */
const withSpeechServer = async (
  task: () => Promise<void>,
  contentType: string | null = "audio/mpeg"
): Promise<SpeechRequest[]> => {
  const requests: SpeechRequest[] = [];
  const warnings: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const originalLogger = globalThis.AI_SDK_LOG_WARNINGS;
  globalThis.AI_SDK_LOG_WARNINGS = (options) => {
    warnings.push(...options.warnings);
  };
  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers,
      url: String(input),
    });
    await Promise.resolve();
    return new Response(new TextEncoder().encode("mp3!"), {
      headers: contentType === null ? {} : { "content-type": contentType },
    });
  };
  // SAFETY: the fake implements the call shape the OpenAI provider uses;
  // `fetch.preconnect` is never touched.
  globalThis.fetch = fakeFetch as typeof fetch;
  try {
    await task();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.AI_SDK_LOG_WARNINGS = originalLogger;
  }
  expect(warnings).toEqual([]);
  return requests;
};

/** A speaker that records what it was asked to say. */
const recorder = () => {
  const said: string[] = [];
  const speak = async (text: string, lang: string) => {
    said.push(`${lang}:${text}`);
    await Promise.resolve();
    return new TextEncoder().encode(`audio:${text}`);
  };
  return { said, speak };
};

describe("htmlTree", () => {
  it("reads elements, text, and nothing else", () => {
    const root = parse('<p class="a">Hi</p>');
    const [p] = root.childNodes;
    const [text] = p?.childNodes ?? [];
    if (!(p && text)) {
      throw new Error("expected a paragraph with text");
    }
    expect(htmlTree.tag(p)).toBe("p");
    expect(htmlTree.attr(p, "class")).toBe("a");
    expect(htmlTree.attr(p, "missing")).toBeNull();
    expect(htmlTree.text(p)).toBeNull();
    expect(htmlTree.children(p)).toHaveLength(1);
    expect(text).toBeInstanceOf(TextNode);
    expect(htmlTree.tag(text)).toBeNull();
    expect(htmlTree.attr(text, "class")).toBeNull();
    expect(htmlTree.text(text)).toBe("Hi");
    expect(htmlTree.tag(root)).toBeNull();
  });
});

describe(readPlayerPage, () => {
  it("reads the player's settings and the article around it", () => {
    const result = readPlayerPage(page({ lang: "de", route: "/guide" }));
    expect(result?.manifest).toBe("/blume-narration/guide.json");
    expect(result?.audioBase).toBe("/blume-narration/audio/");
    expect(result?.lang).toBe("de");
    expect(result?.cues).toEqual(CUES);
    expect(result?.article.tagName).toBe("ARTICLE");
  });

  it("defaults the language to English", () => {
    expect(readPlayerPage(page({ route: "/guide" }))?.lang).toBe("en");
  });

  it("is null without a generated-audio player", () => {
    expect(readPlayerPage("<article><p>No player.</p></article>")).toBeNull();
    expect(readPlayerPage(page({ manifest: null, route: "/x" }))).toBeNull();
    expect(readPlayerPage(page({ cues: "not json", route: "/x" }))).toBeNull();
    expect(readPlayerPage(page({ cues: "{}", route: "/x" }))).toBeNull();
  });
});

describe(clipKey, () => {
  const provider = narrationProviderSchema.parse(gateway());

  it("follows what the clip sounds like", () => {
    const key = clipKey(provider, "en", "Hello.");
    expect(key).toMatch(/^[0-9a-f]{32}$/u);
    expect(clipKey(provider, "en-US", "Hello.")).toBe(key);
    expect(clipKey(provider, "de", "Hello.")).not.toBe(key);
    expect(clipKey(provider, "en", "Hello!")).not.toBe(key);
    const other = narrationProviderSchema.parse(gateway({ voice: "nova" }));
    expect(clipKey(other, "en", "Hello.")).not.toBe(key);
  });

  it("keeps the keys gateway() clips were cached under", () => {
    // Keys from before narration took openai(): changing them would
    // regenerate (and bill) every cached clip.
    expect(clipKey(provider, "en", "Hello.")).toBe(
      "c614df04bc0d8f736de2f4c1ec4702d2"
    );
    const tuned = narrationProviderSchema.parse(
      gateway({
        instructions: "Read calmly.",
        providerOptions: { openai: { speed: 1.2 } },
        voice: "nova",
      })
    );
    expect(clipKey(tuned, "de-AT", "Hallo.")).toBe(
      "cf7d36833ceb18dce563ca35a3d0a070"
    );
  });

  it("follows the provider and endpoint that speak", () => {
    Reflect.deleteProperty(process.env, "OPENAI_BASE_URL");
    const hosted = narrationProviderSchema.parse(
      openai({ model: "openai/tts-1-hd" })
    );
    const keys = [
      provider,
      hosted,
      narrationProviderSchema.parse(
        openai({
          baseUrl: "http://localhost:8880/v1",
          model: "openai/tts-1-hd",
        })
      ),
      narrationProviderSchema.parse(
        openai({ baseUrl: "http://tts.internal/v1", model: "openai/tts-1-hd" })
      ),
    ].map((each) => clipKey(each, "en", "Hello."));
    expect(new Set(keys).size).toBe(keys.length);
    // OPENAI_BASE_URL moves openai() to another server, so the key follows.
    process.env.OPENAI_BASE_URL = "http://llm-proxy.internal/v1";
    expect(clipKey(hosted, "en", "Hello.")).not.toBe(keys[1]);
    // A trailing slash names the same server.
    const slashed = narrationProviderSchema.parse(
      openai({ baseUrl: "http://tts.internal/v1/", model: "openai/tts-1-hd" })
    );
    const unslashed = narrationProviderSchema.parse(
      openai({ baseUrl: "http://tts.internal/v1", model: "openai/tts-1-hd" })
    );
    expect(clipKey(slashed, "en", "Hello.")).toBe(
      clipKey(unslashed, "en", "Hello.")
    );
  });
});

describe(gatewaySpeaker, () => {
  it("asks the gateway's speech model for MP3 in the page's language", async () => {
    process.env.NARRATION_TEST_KEY = "test-key";
    const provider = gatewayProvider({
      apiKeyEnv: "NARRATION_TEST_KEY",
      instructions: "Read calmly.",
      model: "openai/tts-1",
      voice: "nova",
    });
    const requests: { body: string; model: string | null; url: string }[] = [];
    const originalFetch = globalThis.fetch;
    const fakeFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      requests.push({
        body: String(init?.body ?? ""),
        model: new Headers(init?.headers).get("ai-model-id"),
        url: String(input),
      });
      await Promise.resolve();
      return Response.json({ audio: Buffer.from("mp3!").toString("base64") });
    };
    // SAFETY: the fake implements the call shape the gateway provider uses;
    // `fetch.preconnect` is never touched.
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const audio = await gatewaySpeaker(provider)("Hallo.", "de-AT");
      expect(new TextDecoder().decode(audio)).toBe("mp3!");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.endsWith("/speech-model")).toBe(true);
    expect(requests[0]?.model).toBe("openai/tts-1");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      instructions: "Read calmly.",
      language: "de",
      outputFormat: "mp3",
      providerOptions: {},
      text: "Hallo.",
      voice: "nova",
    });
  });
});

describe(openaiSpeaker, () => {
  it("asks a custom endpoint for MP3 without a key", async () => {
    // OpenAI's key is never sent to a server that didn't name it.
    process.env.OPENAI_API_KEY = "sk-openai";
    const speak = openaiSpeaker(
      openaiProvider({
        baseUrl: "http://localhost:8880/v1",
        headers: { "x-team": "docs" },
        model: "kokoro",
        providerOptions: { openai: { speed: 1.25 } },
        voice: "af_heart",
      })
    );
    let audio: Uint8Array = new Uint8Array();
    const requests = await withSpeechServer(async () => {
      audio = await speak("Hallo.", "de-AT");
    });
    expect(new TextDecoder().decode(audio)).toBe("mp3!");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:8880/v1/audio/speech");
    // No key, so no bearer token at all rather than an empty one.
    expect(requests[0]?.authorization).toBeNull();
    expect(requests[0]?.headers.get("x-team")).toBe("docs");
    // OpenAI's speech API takes no language (sending one warns on every
    // clip, which `withSpeechServer` fails on): the model or voice decides it.
    expect(requests[0]?.body).toEqual({
      input: "Hallo.",
      model: "kokoro",
      response_format: "mp3",
      speed: 1.25,
      voice: "af_heart",
    });
  });

  it("sends the key it names, or an Authorization header of its own", async () => {
    process.env.NARRATION_TEST_KEY = "test-key";
    process.env.OPENAI_API_KEY = "sk-openai";
    Reflect.deleteProperty(process.env, "OPENAI_BASE_URL");
    const hosted = openaiSpeaker(
      openaiProvider({
        instructions: "Read calmly.",
        model: "gpt-4o-mini-tts",
      })
    );
    const named = openaiSpeaker(
      openaiProvider({
        apiKeyEnv: "NARRATION_TEST_KEY",
        baseUrl: "http://litellm.internal/v1",
        model: "tts",
      })
    );
    const ownAuth = openaiSpeaker(
      openaiProvider({
        baseUrl: "http://localhost:8880/v1",
        headers: { Authorization: "Basic ZG9jczpkb2Nz" },
        model: "kokoro",
      })
    );
    const requests = await withSpeechServer(async () => {
      await hosted("Hello.", "en");
      await named("Hello.", "en");
      await ownAuth("Hello.", "en");
    });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(requests[0]?.authorization).toBe("Bearer sk-openai");
    expect(requests[0]?.body).toMatchObject({
      instructions: "Read calmly.",
      voice: "alloy",
    });
    expect(requests[1]?.url).toBe("http://litellm.internal/v1/audio/speech");
    expect(requests[1]?.authorization).toBe("Bearer test-key");
    expect(requests[2]?.authorization).toBe("Basic ZG9jczpkb2Nz");
  });

  it("fails a clip the server didn't answer with audio", async () => {
    const speak = openaiSpeaker(
      openaiProvider({ baseUrl: "http://localhost:8880/v1", model: "kokoro" })
    );
    await withSpeechServer(async () => {
      await expect(speak("Hello.", "en")).rejects.toThrow(
        "The speech server answered with text/html; charset=utf-8, not audio"
      );
    }, "text/html; charset=utf-8");
    // A generic binary type is still taken as the clip, and so is a response
    // with no type, which can't be told apart.
    for (const type of ["application/octet-stream", null]) {
      let audio: Uint8Array = new Uint8Array();
      // oxlint-disable-next-line no-await-in-loop -- one fake server at a time
      await withSpeechServer(async () => {
        audio = await speak("Hello.", "en");
      }, type);
      expect(new TextDecoder().decode(audio)).toBe("mp3!");
    }
  });

  it("goes where OPENAI_BASE_URL points without a baseUrl, as OpenAI's SDKs do", async () => {
    process.env.OPENAI_API_KEY = "sk-proxy";
    process.env.OPENAI_BASE_URL = "http://llm-proxy.internal/v1";
    const viaEnv = openaiSpeaker(openaiProvider({ model: "tts-1" }));
    const configured = openaiSpeaker(
      openaiProvider({ baseUrl: "http://localhost:8880/v1", model: "kokoro" })
    );
    const requests = await withSpeechServer(async () => {
      await viaEnv("Hello.", "en");
      await configured("Hello.", "en");
    });
    expect(requests[0]?.url).toBe("http://llm-proxy.internal/v1/audio/speech");
    expect(requests[0]?.authorization).toBe("Bearer sk-proxy");
    // A `baseUrl` in the config wins.
    expect(requests[1]?.url).toBe("http://localhost:8880/v1/audio/speech");
  });
});

describe(missingKey, () => {
  it("names the key a build can't generate without", () => {
    Reflect.deleteProperty(process.env, "AI_GATEWAY_API_KEY");
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    Reflect.deleteProperty(process.env, "VERCEL_OIDC_TOKEN");
    Reflect.deleteProperty(process.env, "NARRATION_TEST_KEY");
    expect(missingKey(gatewayProvider())).toBe("AI_GATEWAY_API_KEY");
    expect(missingKey(openaiProvider({ model: "tts-1" }))).toBe(
      "OPENAI_API_KEY"
    );
    // A key named for a custom endpoint is required too.
    expect(
      missingKey(
        openaiProvider({
          apiKeyEnv: "NARRATION_TEST_KEY",
          baseUrl: "http://litellm.internal/v1",
          model: "tts",
        })
      )
    ).toBe("NARRATION_TEST_KEY");
  });

  it("is null with the key, Vercel's OIDC token, or a custom endpoint naming none", () => {
    Reflect.deleteProperty(process.env, "AI_GATEWAY_API_KEY");
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    expect(
      missingKey(
        openaiProvider({ baseUrl: "http://localhost:8880/v1", model: "kokoro" })
      )
    ).toBeNull();
    process.env.VERCEL_OIDC_TOKEN = "oidc";
    expect(missingKey(gatewayProvider())).toBeNull();
    // The OIDC token only authenticates the gateway.
    expect(missingKey(openaiProvider({ model: "tts-1" }))).toBe(
      "OPENAI_API_KEY"
    );
    process.env.OPENAI_API_KEY = "sk-test";
    expect(missingKey(openaiProvider({ model: "tts-1" }))).toBeNull();
  });
});

describe(narrationCacheDir, () => {
  it("lives under node_modules/.cache when the project has node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-narration-cache-"));
    dirs.push(root);
    const context = { outDir: join(root, ".blume"), root };
    expect(narrationCacheDir(context)).toBe(
      join(root, ".blume", ".cache", "narration")
    );
    await mkdir(join(root, "node_modules"));
    expect(narrationCacheDir(context)).toBe(
      join(root, "node_modules", ".cache", "blume", "narration")
    );
  });
});

describe(buildNarration, () => {
  it("does nothing unless a provider is configured", async () => {
    for (const config of [
      "export default {};\n",
      "export default { narration: true };\n",
      'export default { narration: { enabled: false, provider: { kind: "gateway", options: {}, requiredSecrets: [], runtimeDeps: [] } } };\n',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one fixture at a time
      const { dist, root } = await fixture(config, {});
      // oxlint-disable-next-line no-await-in-loop
      const project = await scanProject(root, { mode: "build" });
      const log: Log = { info: [], warn: [] };
      // oxlint-disable-next-line no-await-in-loop
      expect(await buildNarration(project, dist, logger(log))).toBeNull();
      expect(log.warn).toEqual([]);
    }
  });

  it("warns and skips generation without the provider's key", async () => {
    Reflect.deleteProperty(process.env, "NARRATION_TEST_KEY");
    Reflect.deleteProperty(process.env, "VERCEL_OIDC_TOKEN");
    const { dist, root } = await fixture(PROVIDER_CONFIG, {
      "guide/index.html": page({ route: "/guide" }),
    });
    const project = await scanProject(root, { mode: "build" });
    const log: Log = { info: [], warn: [] };
    expect(await buildNarration(project, dist, logger(log))).toBeNull();
    expect(log.warn[0]).toBe(
      "Narration audio was not generated: NARRATION_TEST_KEY is not set, so pages will be read with browser voices."
    );
    expect(existsSync(join(dist, "blume-narration"))).toBe(false);
  });

  it("warns without OPENAI_API_KEY when openai() has no baseUrl", async () => {
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    const { dist, root } = await fixture(
      OPENAI_CONFIG.replace('baseUrl: "http://localhost:8880/v1", ', ""),
      { "guide/index.html": page({ route: "/guide" }) }
    );
    const project = await scanProject(root, { mode: "build" });
    const log: Log = { info: [], warn: [] };
    expect(await buildNarration(project, dist, logger(log))).toBeNull();
    expect(log.warn[0]).toBe(
      "Narration audio was not generated: OPENAI_API_KEY is not set, so pages will be read with browser voices."
    );
  });

  it("generates through a custom endpoint without a key", async () => {
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    const { dist, root } = await fixture(OPENAI_CONFIG, {
      "guide/index.html": page({ route: "/guide" }),
    });
    const project = await scanProject(root, { mode: "build" });
    const log: Log = { info: [], warn: [] };
    let result: Awaited<ReturnType<typeof buildNarration>> = null;
    const requests = await withSpeechServer(async () => {
      result = await buildNarration(project, dist, logger(log));
    });
    expect(log.warn).toEqual([]);
    expect(result).toMatchObject({ failed: 0, pages: 1, reused: 0 });
    expect(requests.length).toBeGreaterThan(0);
    // Every clip goes to the configured server, with no key and its voice.
    const sent = requests.map(({ authorization, body, url }) => ({
      authorization,
      url,
      voice: body.voice,
    }));
    expect(sent).toEqual(
      requests.map(() => ({
        authorization: null,
        url: "http://localhost:8880/v1/audio/speech",
        voice: "af_heart",
      }))
    );
    expect(log.info[0]).toEndWith("with kokoro");
    const manifest = JSON.parse(
      await readFile(join(dist, "blume-narration", "guide.json"), "utf-8")
    );
    const clip = await readFile(
      join(dist, "blume-narration", "audio", manifest.segments[0].audio),
      "utf-8"
    );
    expect(clip).toBe("mp3!");
  });

  it("writes a clip per sentence and a manifest per page, then reuses them", async () => {
    const { dist, root } = await fixture(PROVIDER_CONFIG, {
      "404.html": "<html><body><p>Not found.</p></body></html>",
      "guide/index.html": page({ lang: "en-US", route: "/guide" }),
      "guide/short/index.html": page({
        body: "<p>Too short.</p>",
        route: "/guide/short",
      }),
      "reference/index.html": page({ manifest: null, route: "/reference" }),
      "zh/index.html": page({
        body: `<p>${"这是一个很长的句子，用来测试中文页面的朗读。".repeat(20)}</p>`,
        lang: "zh",
        route: "/zh",
      }),
    });
    const project = await scanProject(root, { mode: "build" });
    const cacheDir = narrationCacheDir(project.context);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "stale.mp3"), "old");
    await writeFile(join(cacheDir, "crashed.mp3.123.tmp"), "partial");

    const log: Log = { info: [], warn: [] };
    const first = recorder();
    const result = await buildNarration(
      project,
      dist,
      logger(log),
      first.speak
    );
    expect(result?.pages).toBe(2);
    expect(result?.failed).toBe(0);
    expect(result?.reused).toBe(0);
    expect(result?.generated).toBe(first.said.length);
    expect(first.said.slice(0, 2)).toEqual(["en-US:Title", "en-US:Tip."]);
    expect(log.info[0]).toMatch(
      /^Generating narration: \d+ new clip\(s\), [\d,]+ characters, with openai\/tts-1-hd$/u
    );

    const manifest = JSON.parse(
      await readFile(join(dist, "blume-narration", "guide.json"), "utf-8")
    );
    expect(manifest.version).toBe(1);
    expect(manifest.blocks).toEqual(["Title", PROSE]);
    const [title, cue, sentence] = manifest.segments;
    expect(cue.text).toBe("Tip.");
    expect(title).toMatchObject({ block: 0, end: 5, start: 0 });
    expect(sentence).toMatchObject({ block: 1, start: 0 });
    const clip = await readFile(
      join(dist, "blume-narration", "audio", title.audio),
      "utf-8"
    );
    expect(clip).toBe("audio:Title");
    expect(existsSync(join(dist, "blume-narration", "zh.json"))).toBe(true);
    expect(
      existsSync(join(dist, "blume-narration", "guide", "short.json"))
    ).toBe(false);
    expect(existsSync(join(dist, "blume-narration", "reference.json"))).toBe(
      false
    );
    // Stale clips and crashed writes are pruned; the site's clips stay.
    const cached = await readdir(cacheDir);
    expect(cached).not.toContain("stale.mp3");
    expect(cached).not.toContain("crashed.mp3.123.tmp");
    expect(cached).toHaveLength(first.said.length);

    const again = recorder();
    const rebuilt = await buildNarration(
      project,
      dist,
      logger({ info: [], warn: [] }),
      again.speak
    );
    expect(again.said).toEqual([]);
    expect(rebuilt).toEqual({
      failed: 0,
      generated: 0,
      pages: 2,
      reused: first.said.length,
    });
  });

  it("writes under the deployment base as the host serves it", async () => {
    const { dist, root } = await fixture(
      PROVIDER_CONFIG.replace(
        "export default {",
        'export default {\n  deployment: { base: "/docs" },'
      ),
      {
        "größe/index.html": page({
          base: "/docs",
          manifest: `/docs/blume-narration/${encodeURI("größe")}.json`,
          route: "/größe",
        }),
      }
    );
    const project = await scanProject(root, { mode: "build" });
    const { speak } = recorder();
    await buildNarration(project, dist, logger({ info: [], warn: [] }), speak);
    expect(existsSync(join(dist, "blume-narration", "größe.json"))).toBe(true);
    const clips = await readdir(join(dist, "blume-narration", "audio"));
    expect(clips.length).toBeGreaterThan(0);
  });

  it("reports nothing to do when no page has narration", async () => {
    const { dist, root } = await fixture(PROVIDER_CONFIG, {
      "index.html": "<html><body><p>Plain.</p></body></html>",
    });
    const project = await scanProject(root, { mode: "build" });
    const { speak } = recorder();
    expect(
      await buildNarration(project, dist, logger({ info: [], warn: [] }), speak)
    ).toEqual({ failed: 0, generated: 0, pages: 0, reused: 0 });
  });

  it("stops at the first failed clip and leaves those pages to browser voices", async () => {
    process.env.NARRATION_TEST_KEY = "set";
    const { dist, root } = await fixture(PROVIDER_CONFIG, {
      "guide/index.html": page({ route: "/guide" }),
    });
    const project = await scanProject(root, { mode: "build" });
    const log: Log = { info: [], warn: [] };
    let calls = 0;
    const failing = async (): Promise<Uint8Array> => {
      calls += 1;
      await Promise.resolve();
      throw new Error("Invalid API key");
    };
    const result = await buildNarration(project, dist, logger(log), failing);
    expect(result?.pages).toBe(0);
    expect(result?.generated).toBe(0);
    expect(calls).toBeLessThanOrEqual(4);
    expect(log.warn[0]).toBe(
      "Narration stopped generating after a clip failed (Invalid API key). Pages missing clips will be read with browser voices."
    );
    expect(existsSync(join(dist, "blume-narration", "guide.json"))).toBe(false);

    const thrown = await buildNarration(
      project,
      dist,
      logger(log),
      async (): Promise<Uint8Array> => {
        await Promise.resolve();
        // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- a provider that throws a non-Error
        throw "quota";
      }
    );
    expect(thrown?.failed).toBeGreaterThan(0);
    expect(log.warn.at(-1)).toContain("(quota)");
  });
});
