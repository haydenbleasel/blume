import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { scanProject } from "../src/core/project-graph.ts";
import { publishBuildArtifacts } from "../src/deploy/artifacts.ts";
import { describeSitemapFiles } from "../src/deploy/sitemap.ts";
import { pagefind } from "../src/search/adapters/index.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const HOME = "---\ntitle: Home\n---\n# Home\n\nHello.\n";

/** A docs project on disk plus an empty output dir, scanned for a build. */
const fixture = async (
  files: Record<string, string>
): Promise<{ dist: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "blume-artifacts-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  return { dist, root };
};

/** What the writers logged, by level. */
interface Log {
  info: string[];
  warn: string[];
}

/**
 * Scan `root` and publish the artifacts into `dist`; returns the log. The
 * Pagefind indexer is stubbed (it writes the marker directory and reports
 * one page): the real one is covered by the search-build suite, and
 * Pagefind's in-process service cannot be reopened once that suite closes it.
 */
const publish = async (root: string, dist: string): Promise<Log> => {
  const log: Log = { info: [], warn: [] };
  const project = await scanProject(root, { mode: "build" });
  await publishBuildArtifacts(
    project,
    dist,
    {
      info: (message) => log.info.push(message),
      warn: (message) => log.warn.push(message),
    },
    async (outDir) => {
      await mkdir(join(outDir, "pagefind"), { recursive: true });
      return 1;
    }
  );
  return log;
};

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n`;

describe("describeSitemapFiles", () => {
  it("names the single file or the index it fronts", () => {
    const file = { name: "sitemap.xml", xml: "" };
    expect(describeSitemapFiles([file])).toBe("Generated sitemap.xml");
    // Past the per-file URL cap the set is an index plus numbered chunks.
    expect(
      describeSitemapFiles([
        file,
        { name: "sitemap-0.xml", xml: "" },
        { name: "sitemap-1.xml", xml: "" },
      ])
    ).toBe("Generated sitemap.xml (index of 2 sitemap files)");
  });
});

describe("publishBuildArtifacts", () => {
  it("emits the platform redirect files for a static build, keeping a user's own", async () => {
    const { dist, root } = await fixture({
      "blume.config.ts":
        'export default { redirects: [{ from: "/old", to: "/new" }] };\n',
      "docs/index.md": HOME,
    });
    // A `_redirects` Astro already copied from `public/` wins; the manifest
    // and the Vercel file are still written.
    await writeFile(join(dist, "_redirects"), "/mine /yours 301\n", "utf-8");
    const log = await publish(root, dist);
    expect(await readFile(join(dist, "_redirects"), "utf-8")).toBe(
      "/mine /yours 301\n"
    );
    expect(existsSync(join(dist, "vercel.json"))).toBe(true);
    expect(existsSync(join(dist, "blume-redirects.json"))).toBe(true);
    expect(log.info).toContain("Emitted redirect files for 1 redirect(s)");
  });

  it("writes the sitemap once a site is configured, alongside robots and the agent manifest", async () => {
    const { dist, root } = await fixture({
      "blume.config.ts":
        'export default { deployment: { site: "https://docs.example.com" } };\n',
      "docs/index.md": HOME,
    });
    const log = await publish(root, dist);
    expect(existsSync(join(dist, "sitemap.xml"))).toBe(true);
    expect(existsSync(join(dist, "robots.txt"))).toBe(true);
    expect(existsSync(join(dist, "agent-readability.json"))).toBe(true);
    expect(log.info).toContain("Generated sitemap.xml");
  });

  it("leaves llms files a user shipped from public/ alone", async () => {
    const { dist, root } = await fixture({ "docs/index.md": HOME });
    await writeFile(join(dist, "llms.txt"), "mine\n", "utf-8");
    await writeFile(join(dist, "llms-full.txt"), "mine too\n", "utf-8");
    const log = await publish(root, dist);
    expect(await readFile(join(dist, "llms.txt"), "utf-8")).toBe("mine\n");
    expect(log.info.some((line) => line.startsWith("Generated llms"))).toBe(
      false
    );
  });

  it("indexes the rendered pages for the Pagefind provider", async () => {
    const { dist, root } = await fixture({
      "blume.config.ts": `export default { search: ${JSON.stringify(pagefind())} };\n`,
      "docs/index.md": HOME,
    });
    const log = await publish(root, dist);
    expect(existsSync(join(dist, "pagefind"))).toBe(true);
    expect(log.info).toContain("Indexed 1 page(s) for search");

    // Any other provider leaves the built site alone.
    const other = await fixture({ "docs/index.md": HOME });
    await publish(other.root, other.dist);
    expect(existsSync(join(other.dist, "pagefind"))).toBe(false);
  });

  describe("AI catalog", () => {
    it("writes the catalog to both well-known paths, listing the published skills", async () => {
      const { dist, root } = await fixture({
        "blume.config.ts":
          'export default { agents: { skills: "skills" }, deployment: { site: "https://docs.example.com" } };\n',
        "docs/index.md": HOME,
        "skills/simple/SKILL.md": skillMd("simple"),
      });
      const log = await publish(root, dist);
      const catalog = await readFile(
        join(dist, ".well-known", "ai-catalog.json"),
        "utf-8"
      );
      expect(
        await readFile(join(dist, ".well-known", "ard.json"), "utf-8")
      ).toBe(catalog);
      const identifiers = JSON.parse(catalog).entries.map(
        (entry: { identifier: string }) => entry.identifier
      );
      expect(identifiers).toContain("urn:air:docs.example.com:skill:simple");
      expect(log.info).toContain(
        "Generated .well-known/ai-catalog.json (AI Catalog)"
      );
      expect(log.info).toContain(
        "Generated .well-known/ard.json (ARD manifest)"
      );
    });

    it("emits nothing without a deployment.site", async () => {
      const { dist, root } = await fixture({ "docs/index.md": HOME });
      await publish(root, dist);
      expect(existsSync(join(dist, ".well-known", "ai-catalog.json"))).toBe(
        false
      );
    });
  });

  describe("agent skills", () => {
    it("publishes the configured skills and lists them in the index", async () => {
      const { dist, root } = await fixture({
        "blume.config.ts": 'export default { agents: { skills: "skills" } };\n',
        "docs/index.md": HOME,
        "skills/simple/SKILL.md": skillMd("simple"),
      });
      const log = await publish(root, dist);
      const indexPath = join(dist, ".well-known", "agent-skills", "index.json");
      expect(existsSync(indexPath)).toBe(true);
      expect(
        existsSync(
          join(dist, ".well-known", "agent-skills", "simple", "SKILL.md")
        )
      ).toBe(true);
      expect(log.info).toContain(
        "Published 1 agent skill(s) (.well-known/agent-skills/index.json)"
      );
      // The skill also shows up in llms.txt, which lists the published set.
      expect(await readFile(join(dist, "llms.txt"), "utf-8")).toContain(
        "simple"
      );
    });

    it("warns when the skills directory is missing or holds nothing publishable", async () => {
      const missing = await fixture({
        "blume.config.ts": 'export default { agents: { skills: "skills" } };\n',
        "docs/index.md": HOME,
      });
      const missingLog = await publish(missing.root, missing.dist);
      expect(
        missingLog.warn.some((line) => line.includes("which does not exist"))
      ).toBe(true);

      const empty = await fixture({
        "blume.config.ts": 'export default { agents: { skills: "skills" } };\n',
        "docs/index.md": HOME,
        // A skill without the required frontmatter is skipped with a warning
        // of its own, leaving nothing to publish.
        "skills/broken/SKILL.md": "# no frontmatter\n",
      });
      const emptyLog = await publish(empty.root, empty.dist);
      expect(
        emptyLog.warn.some((line) => line.includes('Skill "broken"'))
      ).toBe(true);
      expect(
        emptyLog.warn.some((line) =>
          line.includes("no publishable skills found")
        )
      ).toBe(true);
      expect(existsSync(join(empty.dist, ".well-known", "agent-skills"))).toBe(
        false
      );
    });

    it("yields to a user-shipped agent-skills index", async () => {
      const { dist, root } = await fixture({
        "blume.config.ts": 'export default { agents: { skills: "skills" } };\n',
        "docs/index.md": HOME,
        "skills/simple/SKILL.md": skillMd("simple"),
      });
      const indexPath = join(dist, ".well-known", "agent-skills", "index.json");
      await mkdir(dirname(indexPath), { recursive: true });
      await writeFile(indexPath, "{}", "utf-8");
      const log = await publish(root, dist);
      expect(await readFile(indexPath, "utf-8")).toBe("{}");
      expect(log.info.some((line) => line.startsWith("Published"))).toBe(false);
    });
  });
});
