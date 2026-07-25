import { afterAll, describe, expect, it, mock } from "bun:test";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildSearchIndex } from "../src/search/build.ts";

describe("Pagefind build", () => {
  const buildDirs: string[] = [];
  afterAll(async () => {
    await Promise.all(
      buildDirs.map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  it("skips a rendered page marked as non-indexable", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "blume-pagefind-build-"));
    buildDirs.push(output);
    await Promise.all([
      mkdir(path.join(output, "included")),
      mkdir(path.join(output, "excluded")),
    ]);
    await Promise.all([
      writeFile(
        path.join(output, "included", "index.html"),
        "<html><head><title>Included</title></head><body>included-token</body></html>"
      ),
      writeFile(
        path.join(output, "excluded", "index.html"),
        '<html data-pagefind-ignore="all"><head><title>Excluded</title></head><body>excluded-token</body></html>'
      ),
    ]);

    await buildSearchIndex(output);
    const server = createServer(async (request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      const file = path.join(output, pathname);
      try {
        response.end(await readFile(file));
      } catch {
        response.statusCode = 404;
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    expect(typeof address).toBe("object");
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const pagefind = await import(
      `${pathToFileURL(path.join(output, "pagefind/pagefind.js")).href}?${crypto.randomUUID()}`
    );
    try {
      await pagefind.options({ basePath: `${origin}/pagefind/` });
      await pagefind.init();
      const includedSearch = await pagefind.search("included-token");
      const excludedSearch = await pagefind.search("excluded-token");
      expect(includedSearch.results).toHaveLength(1);
      expect(excludedSearch.results).toHaveLength(0);
    } finally {
      await pagefind.destroy();
      server.close();
      await once(server, "close");
    }
  });

  // Declared after the behavioral test: `buildSearchIndex` imports "pagefind"
  // dynamically per call, so the module mock only affects calls made after it
  // is installed.
  it("throws when Pagefind fails to create an index", async () => {
    mock.module("pagefind", () => ({
      createIndex: () => Promise.resolve({ index: null }),
    }));
    await expect(buildSearchIndex("/nowhere")).rejects.toThrow(
      "Failed to create Pagefind index."
    );
  });
});
