import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

/**
 * `blume audit` end-to-end as a subprocess.
 *
 * The fixture writes the `dist/` tree by hand rather than running a real Astro
 * build: the audit only ever reads built HTML plus the route manifest, so a
 * synthetic build exercises the whole pipeline (crawl → snapshot → graph →
 * checks → report) in milliseconds instead of half a minute.
 */

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-audit-"));
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

const audit = async (
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
  const proc = Bun.spawn(["bun", CLI, "audit", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const CONFIG = `export default {
  title: "Test",
  deployment: { site: "https://x.dev" },
};
`;

/** A built page. `defect` is spliced into the body so each test names its own. */
const html = (options: {
  canonical: string;
  title: string;
  description?: string;
  body?: string;
}): string => `<!doctype html><html lang="en"><head>
<title>${options.title}</title>
${options.description ? `<meta name="description" content="${options.description}">` : ""}
<meta name="viewport" content="width=device-width">
<link rel="canonical" href="${options.canonical}">
</head><body><main><h1>${options.title}</h1>
<p>${"word ".repeat(60)}</p>
${options.body ?? ""}
</main></body></html>
`;

const HOME = html({
  body: '<a href="/broken">The broken page</a>',
  canonical: "https://x.dev/",
  description: "A home page description that is long enough to pass the check.",
  title: "The home page of the site",
});

/** Defect: no meta description, and a body link to a page that was never built. */
const BROKEN = html({
  body: '<a href="/does-not-exist">A link to nowhere</a>',
  canonical: "https://x.dev/broken",
  title: "A page with a reasonable title",
});

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.dev/</loc></url>
  <url><loc>https://x.dev/broken</loc></url>
</urlset>
`;

const ROBOTS =
  "User-agent: *\nAllow: /\n\nSitemap: https://x.dev/sitemap.xml\n";

/**
 * A realistic build. The content root is `docs/`, so `docs/broken.mdx` is served
 * at `/broken` — the built tree has to agree with the route manifest or the
 * source-file mapping (the whole point of the audit) silently drops out.
 */
const site = () => ({
  "blume.config.ts": CONFIG,
  "dist/broken/index.html": BROKEN,
  "dist/index.html": HOME,
  "dist/robots.txt": ROBOTS,
  "dist/sitemap.xml": SITEMAP,
  "docs/broken.mdx": "---\ntitle: Broken\n---\n\nBody.\n",
  "docs/index.mdx":
    "---\ntitle: Home\ndescription: A home page.\n---\n\nBody.\n",
});

/** The same site, with the one link that makes it fail removed. */
const healthyLinks = () => ({
  ...site(),
  "dist/broken/index.html": BROKEN.replace(
    '<a href="/does-not-exist">A link to nowhere</a>',
    ""
  ),
});

describe("blume audit", () => {
  it("fails on a broken link and names the source file that owns it", async () => {
    const root = await fixture(site());
    const { exitCode, stderr } = await audit(root, "--verbose");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Page has links to a broken page");
    // The payoff over a crawler: the finding names the .mdx, not just the URL.
    expect(stderr).toContain("docs/broken.mdx");
    expect(stderr).toContain("/broken");
  });

  it("exits 0 when only warnings are found", async () => {
    // The default gate is `error`. A missing description is a warning, so it
    // must not fail CI on its own.
    const root = await fixture(healthyLinks());
    const { exitCode, stderr } = await audit(root);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Meta description missing or empty");
  });

  it("escalates warnings with --fail-on warning and with --strict", async () => {
    const root = await fixture(healthyLinks());
    const failOn = await audit(root, "--fail-on", "warning");
    const strict = await audit(root, "--strict");
    expect(failOn.exitCode).toBe(1);
    expect(strict.exitCode).toBe(1);
  });

  it("rejects an unknown --fail-on level", async () => {
    const root = await fixture(site());
    const { exitCode, stderr } = await audit(root, "--fail-on", "nope");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid --fail-on");
  });

  it("emits a complete JSON document even when exiting non-zero", async () => {
    // `process.exit` truncates a piped stdout, which is exactly how CI reads
    // this. The payload must survive the failure exit.
    const root = await fixture(site());
    const { exitCode, stdout } = await audit(root, "--json");
    expect(exitCode).toBe(1);

    const payload = JSON.parse(stdout);
    expect(payload.audit.pages).toBe(2);
    expect(payload.summary.error).toBeGreaterThan(0);
    expect(
      payload.diagnostics.some(
        (d: { code: string }) => d.code === "BLUME_AUDIT_LINK_TO_BROKEN"
      )
    ).toBe(true);
  });

  it("narrows to a single check with --only and suppresses with --skip", async () => {
    const root = await fixture(site());

    const only = await audit(root, "--json", "--only", "link_to_broken");
    const onlyCodes = new Set(
      JSON.parse(only.stdout).diagnostics.map((d: { code: string }) => d.code)
    );
    expect([...onlyCodes]).toEqual(["BLUME_AUDIT_LINK_TO_BROKEN"]);

    const skipped = await audit(root, "--json", "--skip", "link_to_broken");
    const skippedCodes = new Set(
      JSON.parse(skipped.stdout).diagnostics.map(
        (d: { code: string }) => d.code
      )
    );
    expect(skippedCodes.has("BLUME_AUDIT_LINK_TO_BROKEN")).toBe(false);
    expect(skipped.exitCode).toBe(0);
  });

  it("filters by category as well as by id", async () => {
    const root = await fixture(site());
    const { stdout } = await audit(root, "--json", "--only", "links");
    const codes = JSON.parse(stdout).diagnostics.map(
      (d: { code: string }) => d.code
    );
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((code: string) => code.startsWith("BLUME_AUDIT_"))).toBe(
      true
    );
  });

  it("prints the catalog with --list-checks and exits 0", async () => {
    const root = await fixture(site());
    const { exitCode, stdout } = await audit(root, "--list-checks");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("checks.");
    expect(stdout).toContain("title_missing");
  });

  it("tells the user to build when there is no build", async () => {
    const root = await fixture({
      "blume.config.ts": CONFIG,
      "docs/index.mdx": "---\ntitle: Home\n---\n\nBody.\n",
    });
    const { exitCode, stderr } = await audit(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Run `blume build` first");
  });

  it("ignores component fragments that Astro emits alongside real pages", async () => {
    // Astro writes standalone HTML for some components. They have no <head> and
    // are never served as routes; auditing them reports every one as missing a
    // title, a viewport, and a lang attribute — noise about markup nobody visits.
    const root = await fixture({
      ...site(),
      "dist/_home/Footer/index.html":
        "<!doctype html><footer><p>A fragment, not a page.</p></footer>",
    });
    const { stdout } = await audit(root, "--json");
    const payload = JSON.parse(stdout);
    expect(payload.audit.pages).toBe(2);
    expect(
      payload.diagnostics.every(
        (d: { url?: string }) => !d.url?.startsWith("/_home")
      )
    ).toBe(true);
  });
});
