import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { parseSpec } from "../src/openapi/parse.ts";
import { openApiSource } from "../src/openapi/source.ts";

/**
 * `x-codeSamples` entries whose `source` is a `$ref` to a file of its own
 * (as Redocly's docs describe): inlined relative to the spec, local or remote,
 * and reported when they can't be.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serve these URLs' bodies; any other URL answers 404. */
const serve = (bodies: Record<string, string>): string[] => {
  const requested: string[] = [];
  globalThis.fetch = Object.assign(
    (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const body = bodies[url];
      return Promise.resolve(
        body === undefined
          ? new Response("missing", { status: 404, statusText: "Not Found" })
          : new Response(body)
      );
    },
    { preconnect: originalFetch.preconnect }
  );
  return requested;
};

/** One `x-codeSamples` entry as a fixture writes it. */
interface SampleFixture {
  lang: string;
  source: string | { $ref: string };
}

/** A spec whose `GET /pets` holds these samples, as JSON text. */
const specWith = (
  samples: SampleFixture[],
  extra: {
    webhooks?: Record<string, { post: Record<string, SampleFixture[]> }>;
  } = {}
): string =>
  JSON.stringify({
    info: { title: "Pets", version: "1" },
    openapi: "3.1.0",
    paths: { "/pets": { get: { "x-codeSamples": samples } } },
    ...extra,
  });

const samplesOf = (
  document: Awaited<ReturnType<typeof parseSpec>>["document"],
  path = "/pets"
) => document.paths?.[path]?.get?.["x-codeSamples"];

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-openapi-sample-refs-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

describe("x-codeSamples source $ref", () => {
  it("inlines a file next to a local spec", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "api/samples"), { recursive: true });
      await writeFile(join(dir, "api/samples/list.go"), "client.Pets.List()\n");
      await writeFile(
        join(dir, "api/openapi.json"),
        specWith(
          [
            { lang: "go", source: { $ref: "./samples/list.go" } },
            { lang: "sh", source: "pets list" },
          ],
          {
            webhooks: {
              newPet: {
                post: {
                  "x-code-samples": [
                    { lang: "go", source: { $ref: "samples/list.go" } },
                  ],
                },
              },
            },
          }
        )
      );
      const { document, issues } = await parseSpec("api/openapi.json", dir);
      expect(issues).toStrictEqual([]);
      expect(samplesOf(document)).toStrictEqual([
        { lang: "go", source: "client.Pets.List()\n" },
        { lang: "sh", source: "pets list" },
      ]);
      expect(document.webhooks?.newPet?.post?.["x-code-samples"]).toStrictEqual(
        [{ lang: "go", source: "client.Pets.List()\n" }]
      );
    });
  });

  it("resolves from an absolute spec path, and reads an absolute ref as is", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "list.go"), "one\n");
      await writeFile(
        join(dir, "openapi.json"),
        specWith([
          { lang: "go", source: { $ref: "list.go" } },
          { lang: "go", source: { $ref: join(dir, "list.go") } },
        ])
      );
      const { document } = await parseSpec(join(dir, "openapi.json"), "/");
      expect(samplesOf(document)).toStrictEqual([
        { lang: "go", source: "one\n" },
        { lang: "go", source: "one\n" },
      ]);
    });
  });

  it("fetches a ref relative to a remote spec, or by its own URL", async () => {
    const requested = serve({
      "https://api.test/docs/openapi.json": specWith([
        { lang: "go", source: { $ref: "../samples/list.go" } },
        { lang: "py", source: { $ref: "https://cdn.test/list.py" } },
      ]),
      "https://api.test/samples/list.go": "go sample",
      "https://cdn.test/list.py": "py sample",
    });
    const { document, issues } = await parseSpec(
      "https://api.test/docs/openapi.json",
      "/"
    );
    expect(issues).toStrictEqual([]);
    expect(samplesOf(document)).toStrictEqual([
      { lang: "go", source: "go sample" },
      { lang: "py", source: "py sample" },
    ]);
    expect(requested.toSorted()).toStrictEqual([
      "https://api.test/docs/openapi.json",
      "https://api.test/samples/list.go",
      "https://cdn.test/list.py",
    ]);
  });

  it("reports a ref it can't read and leaves the entry out", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "openapi.json"),
        specWith([{ lang: "go", source: { $ref: "./missing.go" } }])
      );
      const { document, issues } = await parseSpec("openapi.json", dir);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe("BLUME_OPENAPI_CODE_SAMPLE_REF");
      expect(issues[0]?.message).toStartWith(
        'GET /pets has an `x-codeSamples` entry whose `source` is a $ref to "./missing.go", which couldn\'t be read ('
      );
      expect(issues[0]?.message).toEndWith("), so the sample is left out.");
      expect(issues[0]?.suggestion).toBe(
        "Check the path, which is relative to the spec, or write the code out in `source`."
      );
      // Left as a `$ref`, which the page skips as a malformed entry.
      expect(samplesOf(document)).toStrictEqual([
        { lang: "go", source: { $ref: "./missing.go" } },
      ]);
    });
  });

  it("reports a pointer into a document, which it doesn't resolve", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "openapi.json"),
        specWith([
          { lang: "go", source: { $ref: "#/components/x-samples/list" } },
          { lang: "go", source: { $ref: "./samples.yaml#/list" } },
        ])
      );
      const { issues } = await parseSpec("openapi.json", dir);
      expect(issues.map((issue) => issue.message)).toStrictEqual([
        'GET /pets has an `x-codeSamples` entry whose `source` is a $ref to "#/components/x-samples/list", a spot inside a document, which Blume doesn\'t resolve, so the sample is left out.',
        'GET /pets has an `x-codeSamples` entry whose `source` is a $ref to "./samples.yaml#/list", a spot inside a document, which Blume doesn\'t resolve, so the sample is left out.',
      ]);
      expect(issues[0]?.suggestion).toBe(
        "Point the `$ref` at a file that holds only the sample's code, or write the code out in `source`."
      );
    });
  });

  it("steps over path items and samples it has nothing to resolve in", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "openapi.json"),
        JSON.stringify({
          info: { title: "Pets", version: "1" },
          openapi: "3.1.0",
          paths: {
            "/a": null,
            "/b": { $ref: "#/components/pathItems/b" },
            "/c": { get: { "x-codeSamples": "nope" }, post: "nope" },
            "/d": { get: { "x-codeSamples": [null, { source: { $ref: 7 } }] } },
          },
        })
      );
      const { issues } = await parseSpec("openapi.json", dir);
      expect(issues).toStrictEqual([]);
    });
  });

  it("reports the unread ref as a warning naming the spec", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "openapi.json"),
        specWith([{ lang: "go", source: { $ref: "#/nope" } }])
      );
      const { diagnostics } = await openApiSource(
        [
          {
            basePath: "",
            display: {
              codeSamples: [],
              expandSchemas: false,
              playground: { enabled: true, proxy: false },
            },
            includeInLlms: true,
            includeInSearch: true,
            kind: "openapi",
            label: "API",
            noindex: false,
            route: "/api",
            seoDescriptionSuffix: true,
            slug: "api",
            spec: "openapi.json",
          },
        ],
        { cacheDir: join(dir, "cache"), mode: "build", projectRoot: dir }
      ).load();
      expect(
        diagnostics.map(({ code, severity }) => ({ code, severity }))
      ).toStrictEqual([
        { code: "BLUME_OPENAPI_CODE_SAMPLE_REF", severity: "warning" },
      ]);
      expect(diagnostics[0]?.message).toStartWith(
        'In OpenAPI spec "openapi.json": GET /pets has an `x-codeSamples` entry'
      );
    });
  });
});
