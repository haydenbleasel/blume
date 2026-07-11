import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import {
  droppedArtifactNotices,
  updatePackageScripts,
} from "../src/cli/eject-scripts.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";

const dirs: string[] = [];

const makeRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-eject-scripts-"));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const readPkg = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, "package.json"), "utf-8"));

const config = (raw: Record<string, unknown> = {}): ResolvedConfig =>
  blumeConfigSchema.parse(raw);

describe("updatePackageScripts", () => {
  it("rewrites the Blume scripts to run Astro directly", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "docs",
        scripts: { build: "blume build", dev: "blume dev" },
      })
    );
    await updatePackageScripts(root);
    const pkg = await readPkg(root);
    expect(pkg.scripts).toEqual({
      build: "astro build",
      dev: "astro dev",
      preview: "astro preview",
    });
  });

  it("preserves unrelated scripts and fields", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { blume: "^1.0.0" },
        name: "docs",
        scripts: { dev: "blume dev", lint: "eslint ." },
      })
    );
    await updatePackageScripts(root);
    const pkg = await readPkg(root);
    expect(pkg.dependencies).toEqual({ blume: "^1.0.0" });
    expect((pkg.scripts as Record<string, string>).lint).toBe("eslint .");
    expect((pkg.scripts as Record<string, string>).dev).toBe("astro dev");
  });

  it("adds a scripts block when the package.json has none", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "d" }));
    await updatePackageScripts(root);
    const pkg = await readPkg(root);
    expect(pkg.scripts).toEqual({
      build: "astro build",
      dev: "astro dev",
      preview: "astro preview",
    });
  });

  it("leaves a project without a readable package.json alone", async () => {
    const root = await makeRoot();
    await updatePackageScripts(root);
    expect(existsSync(join(root, "package.json"))).toBe(false);

    await writeFile(join(root, "package.json"), "not json");
    await updatePackageScripts(root);
    expect(await readFile(join(root, "package.json"), "utf-8")).toBe(
      "not json"
    );
  });
});

describe("droppedArtifactNotices", () => {
  it("lists the default-on artifacts for a zero-config project", () => {
    const notices = droppedArtifactNotices(config());
    expect(notices).toContain("llms.txt and llms-full.txt");
    expect(notices.some((notice) => notice.includes("robots.txt"))).toBe(true);
    expect(notices).toContain("agent-readability.json");
    // No deployment.site, no redirects, and the static Orama provider: no
    // sitemap, redirect-file, Pagefind, or hosted-sync notices.
    expect(notices.some((notice) => notice.includes("sitemap.xml"))).toBe(
      false
    );
    expect(notices.some((notice) => notice.includes("_redirects"))).toBe(false);
    expect(notices.some((notice) => notice.includes("Pagefind"))).toBe(false);
    expect(notices.some((notice) => notice.includes("index sync"))).toBe(false);
  });

  it("gives the Pagefind index an actionable post-build hint", () => {
    const notices = droppedArtifactNotices(
      config({ search: { provider: "pagefind" } })
    );
    expect(
      notices.some((notice) =>
        notice.includes("astro build && pagefind --site dist")
      )
    ).toBe(true);
  });

  it("mentions the hosted index sync for a syncing provider", () => {
    const notices = droppedArtifactNotices(
      config({
        search: {
          algolia: { appId: "a", indexName: "i", searchApiKey: "k" },
          provider: "algolia",
        },
      })
    );
    expect(
      notices.some((notice) => notice.includes("hosted algolia index sync"))
    ).toBe(true);
  });

  it("lists sitemap.xml only when deployment.site enables it", () => {
    const notices = droppedArtifactNotices(
      config({ deployment: { site: "https://example.com" } })
    );
    expect(notices.some((notice) => notice.includes("sitemap.xml"))).toBe(true);
  });

  it("lists the platform redirect files only for static output", () => {
    const redirects = [{ from: "/old", to: "/new" }];
    const isStatic = droppedArtifactNotices(config({ redirects }));
    expect(isStatic.some((notice) => notice.includes("_redirects"))).toBe(true);

    const server = droppedArtifactNotices(
      config({
        deployment: { adapter: "vercel", output: "server" },
        redirects,
      })
    );
    expect(server.some((notice) => notice.includes("_redirects"))).toBe(false);
  });

  it("returns nothing when every artifact is switched off", () => {
    const notices = droppedArtifactNotices(
      config({
        ai: { llmsTxt: false },
        search: { provider: "none" },
        seo: { agentReadability: false, robots: false, sitemap: false },
      })
    );
    expect(notices).toEqual([]);
  });
});
