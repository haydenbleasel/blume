import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { buildHomeLinkHeader } from "../src/ai/link-headers.ts";
import { markdownRoutePaths } from "../src/ai/markdown.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import { netlify } from "../src/deploy/adapters/index.ts";
import {
  buildNetlifyConfigHeaders,
  buildNetlifyHeaders,
  headerRules,
} from "../src/deploy/headers.ts";
import type { NetlifyConfigHeaders } from "../src/deploy/headers.ts";
import type { BuildLog } from "../src/deploy/platforms/index.ts";
import {
  emitNetlifyHeaders,
  NETLIFY_CONFIG_FILE,
} from "../src/deploy/platforms/netlify.ts";

/**
 * A `netlify()` server build reads no `_headers` file, so the rules a static
 * build ships there — the homepage `Link` header, the raw Markdown charset,
 * the discovery files' media types and CORS header — ride the Frameworks API
 * config (`.netlify/v1/config.json`) instead.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** A Web Bot Auth key, so the signatures directory gets its media type. */
const ED25519_PUBLIC = {
  crv: "Ed25519",
  kty: "OKP",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};

/** A scanned project on the given deployment, with extra files on disk. */
const project = async (
  deployment: string,
  files: Record<string, string> = {}
): Promise<BlumeProject> => {
  const root = await mkdtemp(join(tmpdir(), "blume-netlify-headers-"));
  dirs.push(root);
  const tree = {
    "blume.config.ts": `export default { deployment: ${deployment}, agents: { webBotAuth: { keys: [${JSON.stringify(ED25519_PUBLIC)}] } } };\n`,
    "docs/index.md": "# Home\n\nWelcome.\n",
    ...files,
  };
  await Promise.all(
    Object.entries(tree).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    })
  );
  return scanProject(root, { mode: "build" });
};

const recorder = () => {
  const warnings: string[] = [];
  const log: BuildLog = {
    error: () => {},
    info: () => {},
    success: () => {},
    warn: (message) => warnings.push(message),
  };
  return { log, warnings };
};

/** The Frameworks API config `@astrojs/netlify` writes. */
const ADAPTER_CONFIG = {
  headers: [
    {
      for: "/_astro/*",
      values: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  ],
  images: { remote_images: [] },
};

describe("buildNetlifyConfigHeaders", () => {
  it("carries every _headers rule, one entry per path", () => {
    const config = blumeConfigSchema.parse({ deployment: { base: "/docs/" } });
    const entries = buildNetlifyConfigHeaders(config, "</llms.txt>; rel=x");
    const rules = headerRules(config, "</llms.txt>; rel=x");
    // Every rule lands on its path, and no path repeats.
    for (const rule of rules) {
      expect(
        entries.find((entry) => entry.for === rule.path)?.values[rule.name]
      ).toBe(rule.value);
    }
    expect(new Set(entries.map((entry) => entry.for)).size).toBe(
      entries.length
    );
    expect(entries).toContainEqual({
      for: "/docs/",
      values: { Link: "</llms.txt>; rel=x" },
    });
    expect(entries).toContainEqual({
      for: "/docs/*.md",
      values: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Robots-Tag": "noindex",
      },
    });
    // The same paths the static `_headers` file names.
    const staticPaths = buildNetlifyHeaders(config, "</llms.txt>; rel=x")
      .split("\n")
      .filter((line) => line.startsWith("/"));
    expect(entries.map((entry) => entry.for)).toStrictEqual([
      ...new Set(staticPaths),
    ]);
  });
});

describe("emitNetlifyHeaders", () => {
  it("writes the static header rules into the Frameworks API config", async () => {
    const built = await project(JSON.stringify(netlify({ base: "/docs" })), {
      [NETLIFY_CONFIG_FILE]: JSON.stringify(ADAPTER_CONFIG),
    });
    const configPath = join(built.context.root, NETLIFY_CONFIG_FILE);
    const quiet = recorder();
    await emitNetlifyHeaders(built, quiet.log);
    expect(quiet.warnings).toStrictEqual([]);

    const homeLink = buildHomeLinkHeader(
      built.config,
      markdownRoutePaths(built)
    );
    expect(homeLink).not.toBeNull();
    const written: {
      headers: NetlifyConfigHeaders[];
      images: { remote_images: string[] };
    } = JSON.parse(await readFile(configPath, "utf-8"));
    expect(written).toStrictEqual({
      headers: [
        ...ADAPTER_CONFIG.headers,
        ...buildNetlifyConfigHeaders(built.config, homeLink),
      ],
      images: { remote_images: [] },
    });
    // The homepage Link header and a discovery file's media type and CORS.
    expect(written.headers).toContainEqual({
      for: "/docs/",
      values: { Link: homeLink ?? "" },
    });
    expect(
      written.headers.find(
        (entry) =>
          entry.for === "/docs/.well-known/http-message-signatures-directory"
      )?.values
    ).toMatchObject({
      "Content-Type": "application/http-message-signatures-directory+json",
    });
    expect(
      written.headers.some(
        (entry) => entry.values["Access-Control-Allow-Origin"] === "*"
      )
    ).toBe(true);

    // A second pass replaces its own entries rather than repeating them.
    await emitNetlifyHeaders(built, recorder().log);
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toStrictEqual(
      written
    );
  });

  it("starts a headers list when the config has none", async () => {
    const built = await project(JSON.stringify(netlify()), {
      [NETLIFY_CONFIG_FILE]: "{}",
    });
    await emitNetlifyHeaders(built, recorder().log);
    expect(
      JSON.parse(
        await readFile(join(built.context.root, NETLIFY_CONFIG_FILE), "utf-8")
      )
    ).toStrictEqual({
      headers: buildNetlifyConfigHeaders(
        built.config,
        buildHomeLinkHeader(built.config, markdownRoutePaths(built))
      ),
    });
  });

  it("warns when the build left no Frameworks API config", async () => {
    const built = await project(JSON.stringify(netlify()));
    const loud = recorder();
    await emitNetlifyHeaders(built, loud.log);
    expect(loud.warnings[0]).toContain("is served without its header rules");
  });
});
