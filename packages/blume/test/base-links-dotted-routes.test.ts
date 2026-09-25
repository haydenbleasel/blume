import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  publishRuntimeModules,
  readRuntimeModule,
  RUNTIME_MODULE_FILES,
} from "../src/astro/runtime-modules.ts";
import type { RuntimeModuleId } from "../src/astro/runtime-modules.ts";
import { blumeMarkdownProcessor } from "../src/markdown/index.ts";

// The base-path rewrite once read any link ending in an extension as a public
// asset, so a dotted page route (`/releases/v1.2`) kept its root-relative href
// and 404ed under `basePath`. A served route wins over the extension now, the
// same test the link checker and the locale rewrite apply.

// Publishing replaces the whole snapshot set; keep whatever another suite left
// so this file can't leak into (or out of) the rest of the process.
const saved = new Map<RuntimeModuleId, string>();
for (const id of RUNTIME_MODULE_FILES.keys()) {
  const text = readRuntimeModule(id);
  if (text !== undefined) {
    saved.set(id, text);
  }
}

const publishData = (text: string | null): void => {
  const modules = new Map(saved);
  if (text === null) {
    modules.delete("blume:data");
  } else {
    modules.set("blume:data", text);
  }
  publishRuntimeModules(modules);
};

afterEach(() => publishRuntimeModules(saved));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const snapshot = (paths: string[]): string =>
  JSON.stringify({
    config: { i18n: null },
    routes: paths.map((path) => ({
      collection: "docs",
      entryId: `${path.slice(1)}.md`,
      fallback: false,
      locale: "",
      path,
    })),
  });

const render = async (
  source: string,
  options: Parameters<typeof blumeMarkdownProcessor>[0]
): Promise<string> => {
  const renderer = await blumeMarkdownProcessor(options).createRenderer({});
  const result = await renderer.render(source);
  return result.code;
};

const LINKS = [
  "[Release](/releases/v1.2#notes)",
  "[Café](/releases/caf%C3%A9.1)",
  "[Guide](/guide)",
  "[Spec](/spec.pdf)",
].join("\n\n");

describe("base-path rewrite of dotted routes", () => {
  it("bases a served dotted route and leaves an asset out of basePath", async () => {
    publishData(
      snapshot(["/docs/guide", "/docs/releases/v1.2", "/docs/releases/café.1"])
    );
    const html = await render(LINKS, { basePath: "/docs", deployBase: "/sub" });
    expect(html).toContain('href="/sub/docs/releases/v1.2#notes"');
    // Routes are stored decoded; the href keeps the author's encoding.
    expect(html).toContain('href="/sub/docs/releases/caf%C3%A9.1"');
    expect(html).toContain('href="/sub/docs/guide"');
    // A public file gains the deployment base, never `basePath`.
    expect(html).toContain('href="/sub/spec.pdf"');
    // An unchanged snapshot is reused, and a republished one read again.
    expect(
      await render("[Release](/releases/v1.2)", { basePath: "/docs" })
    ).toContain('href="/docs/releases/v1.2"');
    publishData(snapshot(["/docs/guide"]));
    expect(
      await render("[Release](/releases/v1.2)", { basePath: "/docs" })
    ).toContain('href="/releases/v1.2"');
  });

  it("treats every dotted link as an asset without a snapshot", async () => {
    publishData(null);
    const html = await render(LINKS, { basePath: "/docs" });
    expect(html).toContain('href="/releases/v1.2#notes"');
    expect(html).toContain('href="/docs/guide"');
  });

  it("reads an ejected app's snapshot file", async () => {
    publishData(null);
    const dir = await mkdtemp(join(tmpdir(), "blume-base-links-"));
    dirs.push(dir);
    const dataFile = join(dir, "data.json");
    await writeFile(dataFile, snapshot(["/docs/releases/v1.2"]));
    expect(
      await render("[Release](/releases/v1.2)", { basePath: "/docs", dataFile })
    ).toContain('href="/docs/releases/v1.2"');
  });
});
