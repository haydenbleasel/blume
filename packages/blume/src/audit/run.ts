import { readFile } from "node:fs/promises";

import { normalizeBasePath } from "../core/base-path.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { Diagnostic } from "../core/types.ts";
import { deployStaticDir } from "../deploy/adapter-output.ts";
import { CHECKS } from "./catalog.ts";
import type { CheckId } from "./catalog.ts";
import { assetChecks } from "./checks/assets.ts";
import { contentChecks } from "./checks/content.ts";
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

/** Read every page's source file once, so findings can cite front matter lines. */
const readSources = async (
  pages: PageSnapshot[]
): Promise<Map<string, string>> => {
  const paths = [
    ...new Set(pages.flatMap((page) => (page.source ? [page.source] : []))),
  ];
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        return [path, await readFile(path, "utf-8")] as const;
      } catch {
        // A staged (non-filesystem) source may not exist on disk. The finding
        // still names the URL; it just can't cite a line.
        return null;
      }
    })
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

  const crawl = await crawlStaticDir({
    basePath: normalizeBasePath(project.config.basePath),
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
    graph: buildGraph(crawl.pages, siteOrigin(project.config.deployment.site)),
    llms: crawl.llms,
    origin,
    pages: crawl.pages,
    project,
    redirects: resolveRedirects(
      project.config.redirects,
      new Set([...byUrl.keys()].map(normalizePath))
    ),
    robots: crawl.robots,
    sitemap: crawl.sitemap,
    sources: await readSources(crawl.pages),
    staticDir,
    thresholds: DEFAULT_THRESHOLDS,
  };

  const tiers: Record<AuditTier, boolean> = {
    external: Boolean(options.external),
    network: origin !== null,
    static: true,
  };

  const results = await Promise.all(
    MODULES.filter((module) => tiers[module.tier]).map((module) =>
      module.run(context)
    )
  );

  let diagnostics = results.flat();
  if (options.only?.length) {
    diagnostics = diagnostics.filter((d) =>
      matches(d.code as CheckId, options.only ?? [])
    );
  }
  if (options.skip?.length) {
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
