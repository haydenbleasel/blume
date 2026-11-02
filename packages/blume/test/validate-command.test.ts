import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { dirname, join } from "pathe";

/**
 * `blume validate` exercised end-to-end as a subprocess: the exit code is the
 * CLI's CI contract, and `--strict` must escalate warnings to failures.
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
  // CI forces color, so read the report as plain text.
  return { exitCode, stderr: stripVTControlCharacters(stderr) };
};

describe("blume validate --strict", () => {
  it("fails on an asset link when the project has no public/ folder", async () => {
    // No `public/` means no public files: the link 404s on the built site.
    const root = await fixture({
      "docs/index.md": "---\ntitle: Home\n---\n\n![logo](/logo.png)\n",
    });
    const { exitCode, stderr } = await validate(root, "--strict");
    expect(stderr).toContain("BLUME_BROKEN_ASSET");
    expect(stderr).toContain("docs/index.md:5:9");
    expect(exitCode).toBe(1);
  });

  it("accepts links to the files the build generates, unless the config turns them off", async () => {
    const files = {
      "docs/index.md": [
        "---",
        "title: Home",
        "---",
        "",
        "[llms.txt](/llms.txt) and [the API](/openapi.json)",
        "",
      ].join("\n"),
    };
    const on = await validate(await fixture(files), "--strict");
    expect(on.stderr).not.toContain("BLUME_BROKEN_ASSET");
    expect(on.exitCode).toBe(0);

    const off = await validate(
      await fixture({
        ...files,
        "blume.config.ts": "export default { agents: { llmsTxt: false } };\n",
      }),
      "--strict"
    );
    expect(off.stderr).toContain("Asset /llms.txt was not found");
    expect(off.stderr).not.toContain("/openapi.json");
    expect(off.exitCode).toBe(1);
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

  // The config imports `blume/reference`, which a fresh `bun` process on a
  // cold Windows runner takes 12-16s to load (the other cases here take ~1s),
  // so this one needs more than the default 5s.
  it("accepts links and redirects to a scalar() reference page", async () => {
    const root = await fixture({
      "blume.config.ts": [
        'import { scalar } from "blume/reference";',
        "",
        "export default {",
        '  redirects: [{ from: "/api-docs", to: "/reference" }],',
        '  reference: [scalar({ spec: "https://x.dev/openapi.json" })],',
        "};",
        "",
      ].join("\n"),
      "docs/a.md": "---\ntitle: A\n---\n\n[API](/reference)\n",
    });
    const { exitCode, stderr } = await validate(root, "--strict");
    expect(stderr).not.toContain("BLUME_BROKEN");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("warns about a redirect to a page that doesn't exist, at its line", async () => {
    const root = await fixture({
      "blume.config.ts": [
        "export default {",
        "  redirects: [",
        '    { from: "/old", to: "/a" },',
        '    { from: "/older", to: "/b" },',
        "  ],",
        "};",
        "",
      ].join("\n"),
      "docs/a.md": "---\ntitle: A\n---\n\nA.\n",
    });
    const { exitCode, stderr } = await validate(root);
    expect(stderr).toContain(
      "BLUME_BROKEN_REDIRECT The redirect from /older sends readers to /b"
    );
    expect(stderr).toContain("blume.config.ts:4:23");
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
