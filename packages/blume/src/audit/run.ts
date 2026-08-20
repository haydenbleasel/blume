import { readFile } from "node:fs/promises";

import pMap from "p-map";

import { normalizeBasePath, withBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { Diagnostic } from "../core/types.ts";
import { deployStaticDir } from "../deploy/adapter-output.ts";
import { CHECKS } from "./catalog.ts";
import type { CheckId } from "./catalog.ts";
import { assetChecks } from "./checks/assets.ts";
import { contentChecks } from "./checks/content.ts";
import { dnsAidChecks } from "./checks/dns-aid.ts";
import { duplicateChecks } from "./checks/duplicates.ts";
import { i18nChecks } from "./checks/i18n.ts";
import { indexabilityChecks } from "./checks/indexability.ts";
import { linkChecks } from "./checks/links.ts";
import { llmsChecks } from "./checks/llms.ts";
import { externalChecks, networkChecks } from "./checks/network.ts";
import { ogImageChecks } from "./checks/og-image.ts";
import { redirectChecks } from "./checks/redirects.ts";
import { robotsChecks } from "./checks/robots.ts";
import { sitemapChecks } from "./checks/sitemap.ts";
import {
  socialChecks,
  structuredDataChecks,
  urlChecks,
} from "./checks/social.ts";
import { crawlStaticDir } from "./crawl.ts";
import { buildGraph } from "./graph.ts";
import { resolveRedirects } from "./redirects.ts";
import { DEFAULT_THRESHOLDS } from "./types.ts";
import type {
  AuditContext,
  AuditTier,
  CheckModule,
  PageSnapshot,
} from "./types.ts";
import { normalizePath, siteOrigin } from "./url.ts";

const MODULES: CheckModule[] = [
  contentChecks,
  duplicateChecks,
  indexabilityChecks,
  linkChecks,
  redirectChecks,
  socialChecks,
  ogImageChecks,
  i18nChecks,
  assetChecks,
  sitemapChecks,
  robotsChecks,
  llmsChecks,
  structuredDataChecks,
  urlChecks,
  networkChecks,
  dnsAidChecks,
  externalChecks,
];

export interface AuditOptions {
  project: BlumeProject;
  /** Origin to probe for the network tier (`--url`). */
  origin?: string;
  /** Probe outbound links (`--external`). */
  external?: boolean;
  /** Only report these check ids or categories. */
  only?: string[];
  /** Suppress these check ids or categories. */
  skip?: string[];
}

export interface AuditResult {
  diagnostics: Diagnostic[];
  staticDir: string;
  pages: number;
  origin: string | null;
  /** Which tiers actually ran. A skipped tier is reported, never hidden. */
  tiers: Record<AuditTier, boolean>;
}

/** Thrown when there's no build to audit. */
export class NoBuildError extends Error {
  readonly staticDir: string;

  constructor(staticDir: string) {
    super(`No build found at ${staticDir}.`);
    this.name = "NoBuildError";
    this.staticDir = staticDir;
  }
}

/** Ceiling on concurrent source reads; unbounded fan-out risks EMFILE. */
const READ_CONCURRENCY = 16;

/** Read every page's source file once, so findings can cite front matter lines. */
const readSources = async (
  pages: PageSnapshot[]
): Promise<Map<string, string>> => {
  const paths = [
    ...new Set(pages.flatMap((page) => (page.source ? [page.source] : []))),
  ];
  const entries = await pMap(
    paths,
    async (path) => {
      try {
        return [path, await readFile(path, "utf-8")] as const;
      } catch {
        // A staged (non-filesystem) source may not exist on disk. The finding
        // still names the URL; it just can't cite a line.
        return null;
      }
    },
    { concurrency: READ_CONCURRENCY }
  );
  return new Map(entries.filter((entry) => entry !== null));
};

/** Does a check id or its category match one of the user's `--only`/`--skip` terms? */
const matches = (id: CheckId, terms: string[]): boolean => {
  const meta = CHECKS.find((check) => check.id === id);
  const short = id.replace("BLUME_AUDIT_", "").toLowerCase();
  return terms.some((raw) => {
    const term = raw.trim().toLowerCase();
    return (
      term === short || term === id.toLowerCase() || term === meta?.category
    );
  });
};

/** Audit a built site. */
export const runAudit = async (options: AuditOptions): Promise<AuditResult> => {
  const { project } = options;
  const staticDir = deployStaticDir(project.config, project.context);
  const basePath = normalizeBasePath(project.config.basePath);

  const crawl = await crawlStaticDir({
    basePath,
    manifest: project.manifest,
    staticDir,
  });
  if (crawl.pages.length === 0) {
    throw new NoBuildError(staticDir);
  }

  const origin = options.origin ?? null;
  const byUrl = new Map(crawl.pages.map((page) => [page.url, page]));
  const context: AuditContext = {
    byUrl,
    files: crawl.files,
    graph: buildGraph(
      crawl.pages,
      siteOrigin(project.config.deployment.site),
      normalizeBasePath(project.config.deployment.base)
    ),
    llms: crawl.llms,
    origin,
    pages: crawl.pages,
    project,
    redirects: resolveRedirects(
      // Redirects are authored as if mounted at root; the built page URLs they
      // are checked against carry `basePath` (it's a real directory in the
      // build), so both sides gain it here — mirroring what
      // `applyBaseToAstroRedirects` does at build time. `withBasePath` is
      // idempotent and leaves external `to` URLs untouched.
      project.config.redirects.map((redirect) => ({
        ...redirect,
        from: withBasePath(basePath, redirect.from),
        to: withBasePath(basePath, redirect.to),
      })),
      // Pages and static files both: a redirect may legitimately land on a
      // served asset (`/old-whitepaper` -> `/files/whitepaper.pdf`).
      new Set(
        [...byUrl.keys(), ...crawl.files.keys()].map((path) =>
          normalizePath(path)
        )
      )
    ),
    robots: crawl.robots,
    sitemap: crawl.sitemap,
    sources: await readSources(crawl.pages),
    staticDir,
    thresholds: DEFAULT_THRESHOLDS,
  };

  const tiers = {
    external: Boolean(options.external),
    network: origin !== null,
    static: true,
  } satisfies Record<AuditTier, boolean>;

  const results = await Promise.all(
    MODULES.filter((module) => tiers[module.tier]).map((module) =>
      module.run(context)
    )
  );

  let diagnostics = results.flat();
  if (options.only?.length) {
    // SAFETY: audit diagnostics are created through `finding()`, whose codes
    // all come from the check catalog's `CheckId` set.
    diagnostics = diagnostics.filter((d) =>
      matches(d.code as CheckId, options.only ?? [])
    );
  }
  if (options.skip?.length) {
    // SAFETY: same invariant — every audit diagnostic code is a catalog `CheckId`.
    diagnostics = diagnostics.filter(
      (d) => !matches(d.code as CheckId, options.skip ?? [])
    );
  }

  return {
    diagnostics,
    origin,
    pages: crawl.pages.length,
    staticDir,
    tiers,
  };
};
