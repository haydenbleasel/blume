import { colors } from "consola/utils";
import type { ColorFunction } from "consola/utils";
import { relative } from "pathe";

import { countBySeverity } from "../core/diagnostics.ts";
import type { Diagnostic, DiagnosticSeverity } from "../core/types.ts";
import { CHECKS, checkMeta } from "./catalog.ts";
import type { CheckId } from "./catalog.ts";
import type { AuditResult } from "./run.ts";
import type { AuditCategory, AuditTier } from "./types.ts";

const SEVERITY_COLOR = {
  error: colors.red,
  info: colors.blue,
  warning: colors.yellow,
} satisfies Record<DiagnosticSeverity, ColorFunction>;

const GLYPH = {
  error: "✖",
  info: "ℹ",
  warning: "⚠",
} satisfies Record<DiagnosticSeverity, string>;

/** How many affected pages to list before collapsing the rest. */
const PREVIEW = 3;

/** The skippable tiers, each with the flag that runs it. */
const TIER_FLAGS: { tier: AuditTier; flag: string }[] = [
  { flag: "--external", tier: "external" },
  { flag: "--url <origin>", tier: "network" },
];

interface CheckRollup {
  id: CheckId;
  count: number;
  severity: DiagnosticSeverity;
  category: AuditCategory;
  title: string;
  findings: Diagnostic[];
}

/**
 * Group findings by check. This is the difference between a report people read
 * and one they close: 214 pages × 6 findings is an unreadable wall, but "Meta
 * description missing — 12 pages" is a to-do list.
 */
export const rollup = (diagnostics: Diagnostic[]): CheckRollup[] => {
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const group = groups.get(diagnostic.code);
    if (group) {
      group.push(diagnostic);
    } else {
      groups.set(diagnostic.code, [diagnostic]);
    }
  }

  const order = {
    error: 0,
    info: 2,
    warning: 1,
  } satisfies Record<DiagnosticSeverity, number>;
  const checks = [...groups.entries()].map(([id, findings]) => {
    // SAFETY: audit findings are only ever created through `finding()`, whose
    // codes are the check catalog's ids.
    const checkId = id as CheckId;
    const { category, severity, title } = checkMeta(checkId);
    return {
      category,
      count: findings.length,
      findings,
      id: checkId,
      severity,
      title,
    };
  });

  // Rank each category by the worst thing in it, so the categories that need
  // attention lead. Sorting on severity alone would interleave the categories
  // and print "content" three separate times.
  const worst = new Map<AuditCategory, number>();
  for (const check of checks) {
    const rank = order[check.severity];
    worst.set(
      check.category,
      Math.min(worst.get(check.category) ?? rank, rank)
    );
  }

  return checks.toSorted(
    (a, b) =>
      (worst.get(a.category) ?? 0) - (worst.get(b.category) ?? 0) ||
      a.category.localeCompare(b.category) ||
      order[a.severity] - order[b.severity] ||
      b.count - a.count
  );
};

/** Categories that had no findings but were never run, and the flag that runs them. */
const skippedTiers = (tiers: Record<AuditTier, boolean>): string[] =>
  TIER_FLAGS.filter(({ tier }) => !tiers[tier]).map(({ flag, tier }) => {
    const label = CHECKS.filter((check) => check.tier === tier).length;
    return `  ${colors.dim(`⊘ ${tier.padEnd(12)} skipped — pass ${flag} (${label} checks)`)}`;
  });

/** How many checks actually ran, i.e. those whose tier was enabled. */
const activeChecks = (tiers: Record<AuditTier, boolean>): number =>
  CHECKS.filter((check) => tiers[check.tier]).length;

/**
 * Individual checks performed: every rule that ran, against every page crawled.
 * The headline number — it's what makes "39 warnings" legible as a proportion
 * rather than a bare count.
 */
export const auditCount = (result: AuditResult): number =>
  activeChecks(result.tiers) * result.pages;

const summaryLine = (
  counts: Record<DiagnosticSeverity, number>,
  audits: number
): string =>
  [
    `${audits.toLocaleString("en-US")} audit${audits === 1 ? "" : "s"}`,
    `${counts.error} error${counts.error === 1 ? "" : "s"}`,
    `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`,
    `${counts.info} note${counts.info === 1 ? "" : "s"}`,
  ].join(" · ");

/** One affected page: the URL, and the source file that fixes it. */
const findingLine = (diagnostic: Diagnostic, root: string): string => {
  const url = diagnostic.url ?? "";
  const source = diagnostic.file
    ? colors.dim(
        `${relative(root, diagnostic.file)}${
          diagnostic.line === undefined ? "" : `:${diagnostic.line}`
        }`
      )
    : "";
  // padEnd alone yields no gap once the URL reaches the column width.
  return `      ${url.padEnd(34)} ${source}`.trimEnd();
};

/**
 * Render the audit as a report grouped by check, with each check's affected
 * pages, the source file to edit, and the fix.
 */
export const formatReport = (
  result: AuditResult,
  root: string,
  options: { verbose?: boolean } = {}
): string => {
  const counts = countBySeverity(result.diagnostics);
  const groups = rollup(result.diagnostics);
  const lines: string[] = [];

  const where = result.origin
    ? `${relative(root, result.staticDir) || "dist"} + ${result.origin}`
    : `${relative(root, result.staticDir) || "dist"} · offline`;
  lines.push(
    "",
    `  ${colors.bold("blume audit")}  ${colors.dim(`${result.pages} pages · ${where}`)}`,
    `  ${summaryLine(counts, auditCount(result))}`,
    ""
  );

  if (groups.length === 0) {
    lines.push(`  ${colors.green("✔ No issues found.")}`, "");
  }

  let category: AuditCategory | null = null;
  for (const group of groups) {
    const { category: next } = group;
    if (next !== category) {
      category = next;
      lines.push(`  ${colors.bold(category)}`, "");
    }

    const color = SEVERITY_COLOR[group.severity];
    const pages = `${group.count} page${group.count === 1 ? "" : "s"}`;
    lines.push(
      `  ${color(`${GLYPH[group.severity]} ${group.title}`)}  ${colors.dim(pages)}`
    );

    const shown = options.verbose
      ? group.findings
      : group.findings.slice(0, PREVIEW);
    for (const diagnostic of shown) {
      lines.push(findingLine(diagnostic, root));
      // The message names the specifics the rolled-up line can't — which target
      // is broken, what the duplicate is — so --verbose prints it per finding.
      if (options.verbose) {
        lines.push(`        ${colors.dim(diagnostic.message)}`);
      }
    }
    const hidden = group.count - shown.length;
    if (hidden > 0) {
      lines.push(`      ${colors.dim(`… and ${hidden} more (--verbose)`)}`);
    }

    // Every finding in a group shares the catalog's fix unless it overrode it,
    // so showing the first one's is showing the group's.
    const [first] = group.findings;
    const fix = first?.suggestion;
    if (fix) {
      lines.push(`      ${colors.cyan(`fix: ${fix}`)}`);
    }
    lines.push("");
  }

  const skipped = skippedTiers(result.tiers);
  if (skipped.length > 0) {
    lines.push(...skipped, "");
  }

  return lines.join("\n");
};

/**
 * The machine-readable report. The existing `diagnostics` + `summary` shape is
 * preserved exactly — anything already parsing `blume validate --json` keeps
 * working — with the audit-specific rollup added alongside it.
 */
export const reportJson = (result: AuditResult, root: string): string => {
  const diagnostics = result.diagnostics.map((diagnostic) =>
    diagnostic.file
      ? { ...diagnostic, file: relative(root, diagnostic.file) }
      : diagnostic
  );
  return `${JSON.stringify(
    {
      audit: {
        /** Checks run × pages crawled — the total number of individual audits. */
        audits: auditCount(result),
        checks: rollup(result.diagnostics).map((group) => ({
          category: group.category,
          count: group.count,
          id: group.id,
          severity: group.severity,
        })),
        origin: result.origin,
        pages: result.pages,
        staticDir: relative(root, result.staticDir),
        tiers: result.tiers,
      },
      diagnostics,
      summary: countBySeverity(result.diagnostics),
    },
    null,
    2
  )}\n`;
};

/** `--list-checks`: the catalog, which is also the docs' source of truth. */
export const formatCatalog = (): string => {
  const lines: string[] = [""];
  let category: AuditCategory | null = null;
  for (const check of [...CHECKS].toSorted((a, b) =>
    a.category.localeCompare(b.category)
  )) {
    const { category: next } = check;
    if (next !== category) {
      category = next;
      lines.push(`  ${colors.bold(category)}`);
    }
    const tier =
      check.tier === "static" ? "" : ` ${colors.dim(`[${check.tier}]`)}`;
    lines.push(
      `    ${SEVERITY_COLOR[check.severity](GLYPH[check.severity])} ${check.id.replace("BLUME_AUDIT_", "").toLowerCase().padEnd(34)} ${colors.dim(check.title)}${tier}`
    );
  }
  lines.push("", `  ${CHECKS.length} checks.`, "");
  return lines.join("\n");
};
