import { describe, expect, it } from "bun:test";

import {
  CHECKS,
  checkDocsUrl,
  checkMeta,
  finding,
} from "../src/audit/catalog.ts";
import {
  auditCount,
  formatCatalog,
  formatReport,
  reportJson,
  rollup,
} from "../src/audit/report.ts";
import type { AuditResult } from "../src/audit/run.ts";

/** The catalog, and the two reporters that render it. */

const strip = (value: string): string =>
  // oxlint-disable-next-line no-control-regex -- strip ANSI colors for assertions
  value.replaceAll(/\[[0-9;]*m/gu, "");

const result = (diagnostics: AuditResult["diagnostics"]): AuditResult => ({
  diagnostics,
  origin: null,
  pages: 10,
  staticDir: "/root/dist",
  tiers: { external: false, network: false, static: true },
});

describe("catalog", () => {
  it("has a unique id for every check", () => {
    const ids = new Set(CHECKS.map((check) => check.id));
    expect(ids.size).toBe(CHECKS.length);
  });

  it("names every id with the BLUME_AUDIT prefix", () => {
    for (const check of CHECKS) {
      expect(check.id.startsWith("BLUME_AUDIT_")).toBe(true);
    }
  });

  it("derives a docs anchor from the id", () => {
    expect(checkDocsUrl("BLUME_AUDIT_TITLE_MISSING")).toBe(
      "https://useblume.dev/docs/reference/audit#title-missing"
    );
  });

  it("throws on an id that is not in the catalog", () => {
    expect(() => checkMeta("BLUME_AUDIT_NOPE" as never)).toThrow(
      "Unknown audit check"
    );
  });

  it("builds a finding that carries the URL and the source line together", () => {
    // Naming both is the whole point: a crawler can only tell you the URL is
    // wrong, but Blume knows which .mdx line to put the cursor on.
    const diagnostic = finding(
      "BLUME_AUDIT_TITLE_MISSING",
      { column: 1, file: "/docs/a.mdx", line: 3, url: "/docs/a" },
      "Page has no <title>."
    );
    expect(diagnostic).toMatchObject({
      code: "BLUME_AUDIT_TITLE_MISSING",
      file: "/docs/a.mdx",
      line: 3,
      severity: "error",
      url: "/docs/a",
    });
    expect(diagnostic.suggestion).toBe(
      checkMeta("BLUME_AUDIT_TITLE_MISSING").fix
    );
  });

  it("lets a finding override the catalog's fix", () => {
    const diagnostic = finding(
      "BLUME_AUDIT_TITLE_MISSING",
      { url: "/" },
      "detail",
      "a specific fix"
    );
    expect(diagnostic.suggestion).toBe("a specific fix");
  });
});

describe("rollup", () => {
  it("groups findings by check, worst category first", () => {
    const groups = rollup([
      finding("BLUME_AUDIT_LOW_WORD_COUNT", { url: "/a" }, "x"),
      finding("BLUME_AUDIT_TITLE_MISSING", { url: "/a" }, "x"),
      finding("BLUME_AUDIT_TITLE_MISSING", { url: "/b" }, "x"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      count: 2,
      id: "BLUME_AUDIT_TITLE_MISSING",
      severity: "error",
    });
  });

  it("keeps each category together rather than interleaving by severity", () => {
    // Sorting on severity alone would print "content" once for its errors and
    // again for its notes, which reads like two different sections.
    const groups = rollup([
      finding("BLUME_AUDIT_LINK_TO_BROKEN", { url: "/a" }, "x"),
      finding("BLUME_AUDIT_TITLE_MISSING", { url: "/a" }, "x"),
      finding("BLUME_AUDIT_LOW_WORD_COUNT", { url: "/a" }, "x"),
    ]);
    expect(groups.map((group) => group.category)).toEqual([
      "content",
      "content",
      "links",
    ]);
  });
});

describe("formatReport", () => {
  it("reports a clean site", () => {
    const text = strip(formatReport(result([]), "/root"));
    expect(text).toContain("No issues found");
    expect(text).toContain("10 pages");
  });

  it("leads with the total number of audits performed", () => {
    // Rules × pages. It's what makes "39 warnings" legible as a proportion
    // rather than a bare count.
    const staticChecks = CHECKS.filter(
      (check) => check.tier === "static"
    ).length;
    const text = strip(formatReport(result([]), "/root"));
    expect(text).toContain(
      `${(staticChecks * 10).toLocaleString("en-US")} audits`
    );
  });

  it("counts only the checks whose tier actually ran", () => {
    // Network checks that never ran must not be counted as audits performed —
    // that would inflate the headline with work the audit didn't do.
    const offline = auditCount(result([]));
    const online = auditCount({
      ...result([]),
      tiers: { external: true, network: true, static: true },
    });
    expect(online).toBeGreaterThan(offline);
  });

  it("rolls affected pages up under the check, not the other way round", () => {
    const diagnostics = Array.from({ length: 6 }, (_, index) =>
      finding("BLUME_AUDIT_TITLE_MISSING", { url: `/p${index}` }, "x")
    );
    const text = strip(formatReport(result(diagnostics), "/root"));
    expect(text).toContain("Title tag missing or empty");
    expect(text).toContain("6 pages");
    // Only a preview is shown; the rest are behind --verbose.
    expect(text).toContain("and 3 more (--verbose)");
    expect(text).not.toContain("/p5");
  });

  it("lists every page with --verbose", () => {
    const diagnostics = Array.from({ length: 6 }, (_, index) =>
      finding("BLUME_AUDIT_TITLE_MISSING", { url: `/p${index}` }, "x")
    );
    const text = strip(
      formatReport(result(diagnostics), "/root", { verbose: true })
    );
    expect(text).toContain("/p5");
    expect(text).not.toContain("--verbose)");
  });

  it("shows the source file a finding maps back to", () => {
    const text = strip(
      formatReport(
        result([
          finding(
            "BLUME_AUDIT_TITLE_MISSING",
            { file: "/root/docs/a.mdx", line: 3, url: "/docs/a" },
            "x"
          ),
        ]),
        "/root"
      )
    );
    expect(text).toContain("/docs/a");
    expect(text).toContain("docs/a.mdx:3");
  });

  it("says which tiers it did not run", () => {
    // A crawler that quietly skips a check is worse than one that says so.
    const text = strip(formatReport(result([]), "/root"));
    expect(text).toContain("network      skipped — pass --url");
    expect(text).toContain("external     skipped — pass --external");
  });
});

describe("reportJson", () => {
  it("preserves the existing diagnostics shape and adds the audit rollup", () => {
    const payload = JSON.parse(
      reportJson(
        result([
          finding(
            "BLUME_AUDIT_TITLE_MISSING",
            { file: "/root/docs/a.mdx", url: "/docs/a" },
            "Page has no <title>."
          ),
        ]),
        "/root"
      )
    );
    expect(payload.summary).toEqual({ error: 1, info: 0, warning: 0 });
    expect(payload.diagnostics[0]).toMatchObject({
      code: "BLUME_AUDIT_TITLE_MISSING",
      file: "docs/a.mdx",
      severity: "error",
      url: "/docs/a",
    });
    expect(payload.audit).toMatchObject({
      audits: auditCount(result([])),
      origin: null,
      pages: 10,
      staticDir: "dist",
    });
    expect(payload.audit.checks[0]).toMatchObject({
      count: 1,
      id: "BLUME_AUDIT_TITLE_MISSING",
    });
    expect(payload.audit.tiers.static).toBe(true);
  });
});

describe("formatCatalog", () => {
  it("lists every check with its tier", () => {
    const text = strip(formatCatalog());
    expect(text).toContain(`${CHECKS.length} checks.`);
    expect(text).toContain("title_missing");
    expect(text).toContain("[network]");
  });
});
