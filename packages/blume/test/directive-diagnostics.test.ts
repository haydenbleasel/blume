import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { unknownDirectiveDiagnostics } from "../src/core/directive-diagnostics.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { SourceEntry } from "../src/core/sources/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

/** An `.mdx` entry with this body (and, optionally, the raw file it came from). */
const entry = (text: string, over: Partial<SourceEntry> = {}): SourceEntry => ({
  body: { format: "mdx", text },
  data: {},
  ref: "guide.mdx",
  sourcePath: "/docs/guide.mdx",
  ...over,
});

describe(unknownDirectiveDiagnostics, () => {
  it("warns about a container that isn't a callout, naming the callout types", () => {
    const diagnostics = unknownDirectiveDiagnostics(
      entry("Intro.\n\n:::details\nBody.\n:::\n", {
        raw: "---\ntitle: Guide\n---\nIntro.\n\n:::details\nBody.\n:::\n",
      }),
      "docs"
    );
    expect(diagnostics).toStrictEqual([
      {
        code: "BLUME_UNKNOWN_DIRECTIVE",
        file: "/docs/guide.mdx",
        // Line 3 of the body, below a three-line front matter block.
        line: 6,
        message:
          "`:::details` isn't a callout type, so the page shows its `:::` lines as written around its content.",
        severity: "warning",
        suggestion:
          "Use a callout type — `danger`, `info`, `note`, `success`, `tip`, `warning` (or the aliases `caution`, `error`, `important`, `warn`) — or remove the `:::` lines to keep the content as plain prose.",
      },
    ]);
  });

  it("finds a misspelled callout nested in a real one", () => {
    const [diagnostic] = unknownDirectiveDiagnostics(
      entry("::::note\n:::warnig\nCareful.\n:::\n::::\n", {
        bodyLineOffset: 10,
      }),
      "docs"
    );
    expect(diagnostic?.message).toStartWith("`:::warnig`");
    expect(diagnostic?.line).toBe(12);
  });

  it("points at the partial a container was included from", () => {
    const [diagnostic] = unknownDirectiveDiagnostics(
      entry("<include>./part.mdx</include>\n", {
        expanded: {
          includes: ["/docs/part.mdx"],
          origins: [
            { file: "/docs/part.mdx", line: 4 },
            { file: "/docs/part.mdx", line: 5 },
          ],
          text: ":::aside\nFrom the partial.\n:::\n",
        },
      }),
      "docs"
    );
    expect(diagnostic).toMatchObject({
      file: "/docs/part.mdx",
      line: 4,
    });
  });

  it("names a remote entry by its source and ref", () => {
    const [diagnostic] = unknownDirectiveDiagnostics(
      entry(":::details\nBody.\n:::\n", { sourcePath: undefined }),
      "cms"
    );
    expect(diagnostic?.file).toBe("cms:guide.mdx");
  });

  it("stays quiet for callouts, code, `.md`, and a body MDX can't parse", () => {
    const quiet = [
      entry(":::note\nA callout.\n:::\n\n:::caution[Alias]\nToo.\n:::\n"),
      entry("```md\n:::details\nAn example.\n:::\n```\n"),
      entry(":::details\n<!-- not MDX -->\n:::\n"),
      entry(":::details\nMarkdown has no directives.\n:::\n", {
        body: { format: "md", text: ":::details\nBody.\n:::\n" },
      }),
    ];
    for (const item of quiet) {
      expect(unknownDirectiveDiagnostics(item, "docs")).toStrictEqual([]);
    }
  });
});

describe("the project scan", () => {
  it("reports an unknown container with the page's other diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-directive-scan-"));
    dirs.push(root);
    const file = join(root, "docs", "guide.mdx");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      "---\ntitle: Guide\n---\n\n:::details[More]\nHidden no longer.\n:::\n"
    );
    const project = await scanProject(root);
    const found = project.diagnostics.filter(
      (diagnostic) => diagnostic.code === "BLUME_UNKNOWN_DIRECTIVE"
    );
    expect(found).toMatchObject([{ file, line: 5, severity: "warning" }]);
  });
});
