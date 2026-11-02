import { describe, expect, it } from "bun:test";

import { colors } from "consola/utils";
import { z } from "zod";

import {
  BlumeError,
  countBySeverity,
  createDiagnostic,
  diagnosticsFromZod,
  enrichDiagnostic,
  formatDiagnostic,
  hasErrors,
  locateFrontmatterKey,
  resolveDocsUrl,
} from "../src/core/diagnostics.ts";
import type { Diagnostic } from "../src/core/types.ts";

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  code: "BLUME_TEST",
  message: "Something went wrong",
  severity: "error",
  ...over,
});

describe("BlumeError", () => {
  it("wraps a diagnostic, exposing its message and a stable name", () => {
    const diagnostic = diag();
    const error = new BlumeError(diagnostic);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Something went wrong");
    expect(error.name).toBe("BlumeError");
    expect(error.diagnostic).toBe(diagnostic);
  });
});

describe("createDiagnostic", () => {
  it("returns the diagnostic unchanged (typed identity)", () => {
    const diagnostic = diag();
    expect(createDiagnostic(diagnostic)).toBe(diagnostic);
  });
});

describe("diagnosticsFromZod", () => {
  it("anchors a path-scoped issue with code, file, and received type", () => {
    const result = z.object({ count: z.number() }).safeParse({ count: "x" });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const [diagnostic] = diagnosticsFromZod(result.error, {
      code: "BLUME_X",
      file: "/abs/a.md",
    });
    expect(diagnostic?.code).toBe("BLUME_X");
    expect(diagnostic?.file).toBe("/abs/a.md");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.schemaPath).toBe("count");
    expect(diagnostic?.message).toContain("count: ");
    // Zod 4's own invalid_type message names the received type.
    expect(diagnostic?.message).toContain("received string");
  });

  it("omits the schema path for a top-level issue", () => {
    const result = z.number().safeParse("nope");
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, { code: "BLUME_Y" });
    expect(diagnostic?.schemaPath).toBeUndefined();
    expect(diagnostic?.message.startsWith(":")).toBe(false);
  });

  it("resolves a nested path to a line/column in the source", () => {
    const source = "title: Docs\nseo:\n  title: 123\n";
    const schema = z.object({ seo: z.object({ title: z.string() }) });
    const result = schema.safeParse({ seo: { title: 123 } });
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, {
      code: "BLUME_FRONTMATTER_INVALID",
      file: "/a.md",
      source,
    });
    // Narrowed under `seo:` to the nested `title:` on line 3.
    expect(diagnostic?.line).toBe(3);
    expect(diagnostic?.column).toBe(3);
  });

  it("doesn't match a key as the tail of a longer key", () => {
    // `subtitle:` precedes `title:`; the `title` segment must skip it.
    const source = "subtitle: ok\ntitle: 123\n";
    const schema = z.object({ title: z.string() });
    const result = schema.safeParse({ title: 123 });
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, {
      code: "BLUME_FRONTMATTER_INVALID",
      source,
    });
    expect(diagnostic?.line).toBe(2);
    expect(diagnostic?.column).toBe(1);
  });

  it("reads a quote that doesn't close on its line as an apostrophe", () => {
    // Read as a string, `it's` would run to the quote on line 4 and swallow
    // the `title` entry in between.
    const source = "seo: {\n  note: it's here,\n  title: 123,\n  tag: 'a'\n}\n";
    const schema = z.object({ seo: z.object({ title: z.string() }) });
    const result = schema.safeParse({ seo: { title: 123 } });
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, {
      code: "BLUME_X",
      source,
    });
    expect(diagnostic?.line).toBe(3);
    expect(diagnostic?.column).toBe(3);
  });

  it("leaves line/column unset when no source is given", () => {
    const result = z.object({ count: z.number() }).safeParse({ count: "x" });
    if (result.success) {
      throw new Error("expected a failure");
    }
    const [diagnostic] = diagnosticsFromZod(result.error, { code: "BLUME_X" });
    expect(diagnostic?.line).toBeUndefined();
    expect(diagnostic?.column).toBeUndefined();
  });
});

describe("locateFrontmatterKey", () => {
  it("counts lines from the top of the file, past the opening fence", () => {
    const source = "---\ntitle: Docs\nseo:\n  description: 1\n---\n# Docs\n";
    expect(locateFrontmatterKey(source, ["seo", "description"])).toEqual({
      column: 3,
      line: 4,
    });
  });

  it("returns undefined for a file with no front matter", () => {
    // The body's `title:` isn't a front matter key, so there's no line to name.
    expect(
      locateFrontmatterKey("# Docs\n\ntitle: body\n", ["title"])
    ).toBeUndefined();
  });
});

describe("formatDiagnostic", () => {
  it("renders code, message, location, suggestion, and docs", () => {
    const out = formatDiagnostic(
      diag({
        column: 4,
        docsUrl: "https://useblume.dev/errors",
        file: "/root/docs/a.md",
        line: 12,
        suggestion: "Fix the link",
      }),
      "/root"
    );
    expect(out).toContain("BLUME_TEST");
    expect(out).toContain("Something went wrong");
    expect(out).toContain("at docs/a.md:12:4");
    expect(out).toContain("fix: Fix the link");
    expect(out).toContain("docs: https://useblume.dev/errors");
  });

  it("uses the absolute file path and omits position when no root or line", () => {
    const out = formatDiagnostic(diag({ file: "/abs/a.md" }));
    expect(out).toContain("at /abs/a.md");
    expect(out).not.toContain("/abs/a.md:");
  });

  // Color output depends on the environment (NO_COLOR/FORCE_COLOR/TTY), so
  // the expectation is built with the same color functions the formatter uses:
  // both sides carry escapes when colors are on and neither does when off.
  it("colors by severity", () => {
    expect(formatDiagnostic(diag({ severity: "error" }))).toContain(
      colors.red(colors.bold("BLUME_TEST"))
    );
    expect(formatDiagnostic(diag({ severity: "warning" }))).toContain(
      colors.yellow(colors.bold("BLUME_TEST"))
    );
    expect(formatDiagnostic(diag({ severity: "info" }))).toContain(
      colors.blue(colors.bold("BLUME_TEST"))
    );
  });
});

describe("resolveDocsUrl / enrichDiagnostic", () => {
  it("maps a known code to its docs page", () => {
    expect(resolveDocsUrl("BLUME_FRONTMATTER_INVALID")).toBe(
      "https://useblume.dev/docs/content/frontmatter"
    );
  });

  it("returns undefined for an unmapped code", () => {
    expect(resolveDocsUrl("BLUME_TEST")).toBeUndefined();
  });

  it("fills docsUrl from the code map when absent", () => {
    const out = enrichDiagnostic(diag({ code: "BLUME_CONFIG_INVALID" }));
    expect(out.docsUrl).toBe("https://useblume.dev/docs/configuration");
  });

  it("keeps an explicit docsUrl", () => {
    const out = enrichDiagnostic(
      diag({ code: "BLUME_CONFIG_INVALID", docsUrl: "https://example.com" })
    );
    expect(out.docsUrl).toBe("https://example.com");
  });
});

describe("hasErrors / countBySeverity", () => {
  const list: Diagnostic[] = [
    diag({ severity: "warning" }),
    diag({ severity: "info" }),
    diag({ severity: "error" }),
    diag({ severity: "error" }),
  ];

  it("detects whether any diagnostic is an error", () => {
    expect(hasErrors(list)).toBe(true);
    expect(hasErrors([diag({ severity: "warning" })])).toBe(false);
    expect(hasErrors([])).toBe(false);
  });

  it("tallies counts per severity", () => {
    expect(countBySeverity(list)).toStrictEqual({
      error: 2,
      info: 1,
      warning: 1,
    });
  });
});
