import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

/**
 * `blume validate` exercised end-to-end as a subprocess: the exit code is the
 * CLI's CI contract, and `--strict` must escalate warnings — but not info-level
 * notes like BLUME_ASSETS_UNCHECKED — to failures.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-validate-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const validate = async (
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string }> => {
  const proc = Bun.spawn(["bun", CLI, "validate", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
};

describe("blume validate --strict", () => {
  it("does not fail on info-level diagnostics", async () => {
    // An asset link with no public/ dir yields only the info-severity
    // BLUME_ASSETS_UNCHECKED note — documented strict behavior is "treat
    // warnings as errors", so this must still exit 0.
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n\n![logo](/logo.png)\n",
    });
    const { exitCode, stderr } = await validate(root, "--strict");
    expect(stderr).toContain("BLUME_ASSETS_UNCHECKED");
    expect(exitCode).toBe(0);
  });

  it("fails on warning-level diagnostics", async () => {
    // A missing anchor is a warning: exit 0 without --strict, 1 with it.
    const files = {
      "docs/a.md": "---\ntitle: A\n---\n\n[bad](/b#nope)\n",
      "docs/b.md": "---\ntitle: B\n---\n\n## Setup\n",
    };
    const lax = await validate(await fixture(files));
    expect(lax.exitCode).toBe(0);

    const strict = await validate(await fixture(files), "--strict");
    expect(strict.stderr).toContain("BLUME_BROKEN_ANCHOR");
    expect(strict.exitCode).toBe(1);
  });
});

describe("blume validate — routes beyond the content graph", () => {
  it("accepts links to custom .astro pages", async () => {
    // `pages/index.astro` serves `/`; a docs link to it must not fail CI as
    // BLUME_BROKEN_LINK just because the graph only knows content routes.
    const root = await fixture({
      "docs/a.md": "---\ntitle: A\n---\n\n[home](/)\n",
      "pages/index.astro": "<h1>home</h1>",
    });
    const { exitCode, stderr } = await validate(root);
    expect(stderr).not.toContain("BLUME_BROKEN_LINK");
    expect(exitCode).toBe(0);
  });

  it("accepts links to the generated /changelog index", async () => {
    const root = await fixture({
      "docs/a.md": "---\ntitle: A\n---\n\n[updates](/changelog)\n",
      "docs/v1.md": "---\ntitle: v1\ntype: changelog\n---\n\nFirst release.\n",
    });
    const { exitCode, stderr } = await validate(root);
    expect(stderr).not.toContain("BLUME_BROKEN_LINK");
    expect(exitCode).toBe(0);
  });

  it("accepts links to fallback-rendered locale routes", async () => {
    // `guide.md` has no French translation, but the build prerenders the
    // fallback locale's content at `/fr/guide` (docs/content/i18n.mdx promises
    // "the link works") — a French page linking it must not fail validation.
    const root = await fixture({
      "blume.config.ts": [
        "export default {",
        '  i18n: { locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },',
        "};",
        "",
      ].join("\n"),
      "docs/fr/intro.md": "---\ntitle: Intro\n---\n\n[guide](./guide)\n",
      "docs/guide.md": "---\ntitle: Guide\n---\n\nSteps.\n",
      "docs/intro.md": "---\ntitle: Intro\n---\n\n[guide](./guide)\n",
    });
    const { exitCode, stderr } = await validate(root);
    expect(stderr).not.toContain("BLUME_BROKEN_LINK");
    expect(exitCode).toBe(0);
  });

  it("still fails for a route no page serves, pointing at the raw file line", async () => {
    const root = await fixture({
      "docs/a.md": "---\ntitle: A\n---\n\n[nope](/missing)\n",
      "pages/index.astro": "<h1>home</h1>",
    });
    const { exitCode, stderr } = await validate(root);
    expect(stderr).toContain("BLUME_BROKEN_LINK");
    // The link sits on line 5 of the file *including* its frontmatter block —
    // the reported position must not be the stripped-body line 2.
    expect(stderr).toContain("docs/a.md:5:8");
    expect(exitCode).toBe(1);
  });
});

describe("blume validate --ignore", () => {
  it("never requests an external URL that a repeated --ignore glob matches", async () => {
    // citty keeps only the last value of a repeated string flag, so this runs
    // the real CLI: every `--ignore`, in either spelling, has to count.
    const requested: string[] = [];
    const server = Bun.serve({
      fetch(request) {
        requested.push(new URL(request.url).pathname);
        return new Response("gone", { status: 404 });
      },
      port: 0,
    });
    const origin = `http://localhost:${server.port}`;
    try {
      const root = await fixture({
        "docs/a.md": [
          "---",
          "title: A",
          "---",
          "",
          `[placeholder](${origin}/placeholder/api)`,
          "",
          `[local](${origin}/local)`,
          "",
          `[gone](${origin}/gone)`,
          "",
        ].join("\n"),
      });
      const { exitCode, stderr } = await validate(
        root,
        "--external",
        "--ignore",
        `${origin}/placeholder/**`,
        `--ignore=${origin}/local`
      );
      expect(stderr).toContain(`External link ${origin}/gone is unreachable`);
      expect(stderr).not.toContain("/placeholder/api");
      expect(stderr).not.toContain(`${origin}/local`);
      expect(requested).toEqual(["/gone"]);
      expect(exitCode).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
