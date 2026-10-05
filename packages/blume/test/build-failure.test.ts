import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import { dirname, join } from "pathe";

import { astroBuildDiagnostics } from "../src/cli/build-failure.ts";
import { packageRoot } from "../src/core/package-root.ts";

/** An error carrying extra fields, the way Rolldown and Vite attach them. */
const errorWith = (
  message: string,
  fields: Record<string, string | Error[] | Record<string, string | number>>,
  name = "Error"
): Error => {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, fields);
};

describe("astroBuildDiagnostics", () => {
  it("reports each failure Rolldown collected at the file and position it names", () => {
    const mdx = errorWith(
      "11:1: Unexpected end of file in expression",
      {
        id: "/site/docs/index.mdx",
        loc: { column: 1, file: "/site/docs/index.mdx", line: 11 },
      },
      "MDXError"
    );
    const unresolved = errorWith("Could not resolve './missing.astro'", {
      id: "/site/docs/guide.mdx",
    });
    const aggregate = errorWith("Build failed with 2 errors:\n\n…", {
      errors: [mdx, unresolved],
    });

    expect(astroBuildDiagnostics(aggregate)).toEqual([
      {
        code: "BLUME_BUILD_FAILED",
        column: 1,
        file: "/site/docs/index.mdx",
        line: 11,
        message: "MDXError: 11:1: Unexpected end of file in expression",
        severity: "error",
      },
      {
        code: "BLUME_BUILD_FAILED",
        column: undefined,
        file: "/site/docs/guide.mdx",
        line: undefined,
        message: "Could not resolve './missing.astro'",
        severity: "error",
      },
    ]);
  });

  it("reports an error with nothing collected as itself", () => {
    const [diagnostic] = astroBuildDiagnostics(
      errorWith("Cannot read properties of undefined", { errors: [] })
    );
    expect(diagnostic).toEqual({
      code: "BLUME_BUILD_FAILED",
      column: undefined,
      file: undefined,
      line: undefined,
      message: "Cannot read properties of undefined",
      severity: "error",
    });
  });

  it("keeps the diagnostic of a BlumeError raised inside the build", () => {
    // An `astro:build:done` hook runs Blume's source, so its BlumeError is a
    // copy of the class the CLI bundle's `instanceof` doesn't match.
    const diagnostic = {
      code: "BLUME_SEARCH_SYNC_FAILED",
      message: "Search sync to typesense failed: Forbidden",
      severity: "error",
      suggestion: "Check TYPESENSE_ADMIN_API_KEY.",
    } as const;
    expect(
      astroBuildDiagnostics(
        errorWith(diagnostic.message, { diagnostic }, "BlumeError")
      )
    ).toEqual([diagnostic]);
  });

  it("drops a location it can't read rather than guessing", () => {
    const [diagnostic] = astroBuildDiagnostics(
      errorWith("Broken", { loc: { file: "/site/a.mdx", line: "eleven" } })
    );
    expect(diagnostic?.file).toBeUndefined();
    expect(diagnostic?.message).toBe("Broken");
  });
});

/**
 * End to end: a page Blume's own checks pass but Astro's MDX compile rejects
 * fails the build as a build error at that page, and a BlumeError raised in
 * an Astro hook keeps its own code, neither of them as `BLUME_INTERNAL`.
 */
describe("blume build failures", () => {
  const PACKAGE_ROOT = packageRoot();
  const CLI = join(PACKAGE_ROOT, "bin", "blume.mjs");
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { force: true, recursive: true }))
    );
  });

  // Local fonts keep the build off Google Fonts (see
  // configured-integrations.test.ts); KaTeX ships a real font file.
  const LOCAL_FONT = join(
    PACKAGE_ROOT,
    "node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2"
  );
  const localFont = { name: "Probe", variants: [{ src: LOCAL_FONT }] };

  const writeProject = async (
    files: Record<string, string>
  ): Promise<string> => {
    const root = await mkdtemp(join(PACKAGE_ROOT, "blume-build-failure-"));
    roots.push(root);
    await Promise.all(
      Object.entries(files).map(async ([relativePath, content]) => {
        const path = join(root, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf-8");
      })
    );
    // Generated configs resolve bare `blume/*` imports from the fixture root.
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(PACKAGE_ROOT, join(root, "node_modules/blume"), "junction");
    return root;
  };

  const fonts = `theme: { fonts: ${JSON.stringify({
    body: localFont,
    display: localFont,
    mono: localFont,
  })} }`;

  /** Run `blume build` in `root`: its exit code and everything it printed. */
  const build = async (
    root: string,
    args: string[],
    env: Record<string, string> = {}
  ): Promise<{ exitCode: number; text: string }> => {
    const proc = Bun.spawn(["bun", CLI, "build", ...args], {
      cwd: root,
      env: { ...process.env, ...env, NO_COLOR: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const output = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // A failing build exits on its own; the guard only keeps a wedged one
    // from holding the suite until the runner's timeout.
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(90_000).then(() => null),
    ]);
    if (exitCode === null) {
      proc.kill("SIGKILL");
      throw new Error("`blume build` did not exit within 90s");
    }
    const streams = await output;
    return { exitCode, text: streams.join("\n") };
  };

  it("reports the page and position, not an internal error", async () => {
    const root = await writeProject({
      "blume.config.ts": `export default { ${fonts} };\n`,
      "docs/index.mdx":
        '---\ntitle: Home\n---\n\n<Callout type="info">\nHello\n</Callout>\n\n{oops\n',
    });
    const { exitCode, text } = await build(root, ["--isolated"]);
    expect(exitCode).toBe(1);
    expect(text).toContain("BLUME_BUILD_FAILED MDXError: 9:1:");
    // Under Node the location is the page's 9:1 as well; Bun stamps its own
    // `line`/`column` on every error, which the MDX plugin prefers, so only
    // the file is stable here.
    expect(text).toMatch(/at docs\/index\.mdx:\d+:\d+/u);
    expect(text).not.toContain("BLUME_INTERNAL");
    expect(text).not.toContain("likely a bug in Blume");
  }, 120_000);

  it("fails with the sync's own code when a hosted search sync fails", async () => {
    // A Typesense host nothing listens on refuses the connection at once. The
    // sync runs in `astro:build:done`, which an isolated build skips.
    const root = await writeProject({
      "blume.config.ts": `import { typesense } from "blume/search";

export default {
  search: typesense({ apiKey: "k", collection: "docs", host: "127.0.0.1", port: 1, protocol: "http" }),
  ${fonts},
};
`,
      "docs/index.md": "# Home\n\nHello.\n",
    });
    const { exitCode, text } = await build(root, [], {
      TYPESENSE_ADMIN_API_KEY: "admin",
    });
    expect(exitCode).toBe(1);
    expect(text).toContain(
      "BLUME_SEARCH_SYNC_FAILED Search sync to typesense failed:"
    );
    expect(text).toContain("unset TYPESENSE_ADMIN_API_KEY");
    expect(text).not.toContain("BLUME_BUILD_FAILED");
  }, 120_000);
});
