import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { createAskContext } from "../src/ai/ask-context.ts";
import { buildAskData } from "../src/ai/ask-data.ts";
import { scanProject } from "../src/core/project-graph.ts";

/**
 * On a versioned site the assistant grounds its answer in the docs version
 * the reader is viewing — the current docs, unless they're on an archived
 * page — as the search dialog scopes its results, rather than letting frozen
 * copies of each page crowd the current ones out.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const INSTALL = (version: string): string =>
  `---\ntitle: Install\n---\n# Install\n\nInstall the ${version} release with npm.\n`;

const scan = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "blume-ask-versions-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  return await scanProject(root);
};

/** The `## [Title](route)` headings a grounded system prompt cites. */
const cited = (system: string | undefined): string[] =>
  [...(system ?? "").matchAll(/^## \[.*\]\((?<route>\/[^)]*)\)/gmu)].map(
    (match) => match.groups?.route ?? ""
  );

const QUESTION = [{ content: "How do I install it with npm?", role: "user" }];

describe("assistant grounding on a versioned site", () => {
  it("carries each document's version and marks the snapshot versioned", async () => {
    const data = await buildAskData(
      await scan({
        "blume.config.ts":
          'export default { versions: { archived: [{ id: "v1.0" }], current: { label: "v2.0" } } };\n',
        "docs/install.md": INSTALL("current"),
        "docs/v1.0/install.md": INSTALL("v1.0"),
      })
    );
    expect(data.versioned).toBe(true);
    expect(
      Object.fromEntries(data.documents.map((doc) => [doc.route, doc.version]))
    ).toStrictEqual({ "/install": "", "/v1.0/install": "v1.0" });
  });

  it("grounds in the version being read, the current docs by default", async () => {
    const data = await buildAskData(
      await scan({
        "blume.config.ts":
          'export default { versions: { archived: [{ id: "v1.0" }], current: { label: "v2.0" } } };\n',
        "docs/install.md": INSTALL("current"),
        "docs/v1.0/install.md": INSTALL("v1.0"),
      })
    );
    const ground = createAskContext(data);
    expect(cited(await ground(QUESTION))).toStrictEqual(["/install"]);
    expect(
      cited(await ground(QUESTION, { path: "/v1.0/install" }))
    ).toStrictEqual(["/v1.0/install"]);
    expect(cited(await ground(QUESTION, { path: "/install" }))).toStrictEqual([
      "/install",
    ]);
  });

  it("leaves an unversioned site's snapshot and retrieval as they were", async () => {
    const data = await buildAskData(
      await scan({ "docs/install.md": INSTALL("current") })
    );
    expect(data.versioned).toBeUndefined();
    expect(data.documents[0]?.version).toBeUndefined();
    expect(cited(await createAskContext(data)(QUESTION))).toStrictEqual([
      "/install",
    ]);
  });
});
