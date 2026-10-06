import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { PreviewServer as AstroPreviewServer } from "astro";
import { join } from "pathe";

import { previewPageUrl, servePagesFirst } from "../src/cli/preview-pages.ts";

/**
 * `blume preview` on a static build whose redirect from a page's `.html` URL
 * (`/docs/model.html` -> `/docs/model`, as a migration from VitePress writes)
 * leaves a redirect page at `dist/docs/model.html/index.html`, a directory
 * beside the page's own `dist/docs/model/index.html`.
 */

const PAGE = "<!doctype html><title>Model</title><p>The real page.</p>";
const REDIRECT_PAGE =
  '<!doctype html><meta http-equiv="refresh" content="0;url=/docs/model">';

let root: string;
let dist: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "blume-preview-pages-"));
  dist = join(root, "dist");
  const files = {
    "docs/model.html/index.html": REDIRECT_PAGE,
    "docs/model/index.html": PAGE,
    // A redirect from an `.html` URL no page is served beside.
    "gone.html/index.html": REDIRECT_PAGE,
    // A page without a redirect from its `.html` URL.
    "guide/index.html": PAGE,
    "index.html": PAGE,
  };
  await Promise.all(
    Object.entries(files).map(async ([path, html]) => {
      const file = join(dist, path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, html);
    })
  );
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("previewPageUrl", () => {
  it("names the page's index.html when its .html URL is a directory", () => {
    expect(previewPageUrl(dist, "", "/docs/model")).toBe(
      "/docs/model/index.html"
    );
    expect(previewPageUrl(dist, "", "/docs/model?tab=1#setup")).toBe(
      "/docs/model/index.html?tab=1#setup"
    );
    // The URL keeps its own spelling; the lookup decodes it.
    expect(previewPageUrl(dist, "", "/docs/mod%65l")).toBe(
      "/docs/mod%65l/index.html"
    );
    // `deployment.base` is in the URL, not in `dist/`.
    expect(previewPageUrl(dist, "/base", "/base/docs/model")).toBe(
      "/base/docs/model/index.html"
    );
  });

  it("leaves every other request to Vite", () => {
    for (const url of [
      // No redirect from the page's `.html` URL.
      "/guide",
      // A redirect page with no page beside it.
      "/gone",
      // The redirect page's own URL, and a slashed one.
      "/docs/model.html",
      "/docs/model/",
      "/",
      // Not a URL that decodes, and one that climbs out of `dist/`.
      "/docs/%E0%A4%A",
      "/../outside",
    ]) {
      expect(previewPageUrl(dist, "", url)).toBeNull();
    }
  });
});

/** The body and status `path` answers with on `origin`. */
const fetchPage = async (
  origin: string,
  path: string
): Promise<{ body: string; status: number }> => {
  const response = await fetch(`${origin}${path}`, {
    headers: { accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  return { body: await response.text(), status: response.status };
};

describe("servePagesFirst", () => {
  it("rewrites requests before the server's own handler sees them", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.url);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const handle: AstroPreviewServer & { server: typeof server } = {
        closed: async () => {},
        port: 0,
        server,
        stop: async () => {},
      };
      servePagesFirst(handle, dist, "");
      // SAFETY: a server listening on a TCP port reports an AddressInfo.
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      expect(await fetchPage(origin, "/docs/model")).toStrictEqual({
        body: "/docs/model/index.html",
        status: 200,
      });
      expect(await fetchPage(origin, "/guide")).toStrictEqual({
        body: "/guide",
        status: 200,
      });
    } finally {
      server.close();
    }
  });

  it("leaves a preview without an HTTP server alone", () => {
    const handle: AstroPreviewServer = {
      closed: async () => {},
      port: 0,
      stop: async () => {},
    };
    expect(() => servePagesFirst(handle, dist, "")).not.toThrow();
  });

  it("serves the page instead of the redirect page from static preview", async () => {
    const server = createServer(async (request, response) => {
      const requestPath = request.url ?? "/";
      // Vite's HTML fallback checks `<route>.html` for extensionless requests.
      // When that path is a directory, reading it fails instead of serving the
      // page at `<route>/index.html`.
      const file = nodePath.extname(requestPath)
        ? requestPath
        : `${requestPath}.html`;
      try {
        const page = await readFile(join(dist, file));
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    const { port } = server.address() as AddressInfo;
    const handle: AstroPreviewServer & { server: typeof server } = {
      closed: async () => {},
      port,
      server,
      stop: async () => {},
    };
    try {
      const origin = `http://127.0.0.1:${port}`;
      expect(await fetchPage(origin, "/docs/model")).toMatchObject({
        status: 500,
      });
      servePagesFirst(handle, dist, "");
      expect(await fetchPage(origin, "/docs/model")).toStrictEqual({
        body: PAGE,
        status: 200,
      });
    } finally {
      server.close();
    }
  });
});
