import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { dirname, join, resolve } from "pathe";

import { buildAgentReadability } from "../ai/agent-readability.ts";
import { advertisedConfig, servesMcp } from "../ai/agent-surface.ts";
import {
  AI_CATALOG_PATH,
  ARD_MANIFEST_PATH,
  buildAiCatalog,
} from "../ai/ai-catalog.ts";
import { API_CATALOG_PATH, buildApiCatalog } from "../ai/api-catalog.ts";
import { buildHomeLinkHeader } from "../ai/link-headers.ts";
import { buildLlmsFiles } from "../ai/llms.ts";
import { markdownRoutePaths } from "../ai/markdown.ts";
import {
  AGENT_SKILLS_DIR,
  AGENT_SKILLS_INDEX_PATH,
  buildSkillsIndex,
  collectSkills,
} from "../ai/skills.ts";
import type { SkillArtifact } from "../ai/skills.ts";
import {
  buildSignaturesDirectory,
  SIGNATURES_DIRECTORY_PATH,
} from "../ai/web-bot-auth.ts";
import { normalizeBasePath } from "../core/base-path.ts";
import { discoverPagesSync } from "../core/custom-pages.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { buildSearchIndex } from "../search/build.ts";
import { syncSearchProvider } from "../search/sync/index.ts";
import { readsHeaderFiles } from "./adapter-output.ts";
import { buildNetlifyHeaders, buildVercelHeaders } from "./headers.ts";
import { deployPlatform } from "./platforms/index.ts";
import { VERCEL_JSON_FILE } from "./platforms/vercel.ts";
import {
  buildRedirectManifest,
  buildVercelConfig,
  platformRedirects,
} from "./redirects.ts";
import { buildRobots } from "./robots.ts";
import { buildSitemapFiles, describeSitemapFiles } from "./sitemap.ts";

/**
 * The deploy artifacts Blume layers onto Astro's build output: the search
 * index (and hosted-provider sync), llms.txt, sitemap, robots, the
 * agent-readability manifest, the `.well-known` discovery files, Agent
 * Skills, and the platform `_redirects`/`_headers` files.
 *
 * Written from the integration's `astro:build:done` hook — Astro's channel
 * for exactly this kind of post-build work — into the directory Astro
 * reports as the client output (`dist/`, or `dist/client` for a server
 * build, or `dist/client/<base>/` on Cloudflare, whose `_headers` goes to
 * the root the platform serves above it). The Vercel adapter copies that
 * directory into its Build Output static tree in a later hook, so the
 * artifacts ride along; every other adapter serves it directly. Running
 * inside the hook rather than after `astro build` returns means an ejected
 * project keeps producing them.
 *
 * Every file yields to one the user ships in `public/` (Astro copied it into
 * the output before this runs).
 */

/** The log surface the writers report through (Astro's integration logger). */
export interface ArtifactLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Emit platform redirect files for a static build (a server build answers
 * redirects at request time): the files the deployment's platform reads
 * (`_redirects`, `vercel.json` — every one of them when no host is named),
 * each only when the user hasn't shipped one via public/, plus the
 * `blume-redirects.json` manifest when no host is named. `vercel.json` also
 * carries the header rules `_headers` gives the other hosts, since Vercel reads
 * no `_headers`, so it is written even with no redirects. Note that Vercel's
 * git-integration builds read `vercel.json` from the repository root only —
 * the copy emitted here takes effect when the dist folder itself is deployed
 * directly via the Vercel CLI.
 */
const emitRedirectFiles = async (
  project: BlumeProject,
  distDir: string,
  logger: ArtifactLogger
): Promise<void> => {
  const { config } = project;
  if (config.deployment.options.output !== "static") {
    return;
  }
  const platform = deployPlatform(config.deployment);
  const redirects = platformRedirects(project);
  const vercelHeaders = platform.redirectFiles.includes(VERCEL_JSON_FILE)
    ? buildVercelHeaders(
        config,
        buildHomeLinkHeader(config, markdownRoutePaths(project))
      )
    : [];
  const files = platform.redirectFiles.filter(
    (file) =>
      !existsSync(join(distDir, file.name)) &&
      (redirects.length > 0 ||
        (file === VERCEL_JSON_FILE && vercelHeaders.length > 0))
  );
  await Promise.all(
    files.map((file) =>
      writeFile(
        join(distDir, file.name),
        file === VERCEL_JSON_FILE
          ? buildVercelConfig(redirects, vercelHeaders)
          : file.build(redirects),
        "utf-8"
      )
    )
  );
  if (redirects.length === 0) {
    return;
  }
  // The manifest is for a host Blume can't name, where nothing reads the
  // platform files above.
  if (platform.kind === "static") {
    await writeFile(
      join(distDir, "blume-redirects.json"),
      buildRedirectManifest(redirects),
      "utf-8"
    );
  }
  logger.info(`Emitted redirect files for ${redirects.length} redirect(s)`);
};

/**
 * The root of the static assets the platform serves, where it reads
 * `_headers`: `distDir` itself, except on a server build whose adapter moved
 * the client output under `deployment.base` (`@astrojs/cloudflare` hands
 * `astro:build:done` `dist/client/<base>/` but serves `dist/client`). A file
 * left in `distDir` there would never be read, and would be served publicly
 * at `<base>/_headers`.
 */
const assetsRoot = (config: ResolvedConfig, distDir: string): string => {
  const base = normalizeBasePath(config.deployment.options.base);
  const nested =
    config.deployment.options.output === "server" &&
    deployPlatform(config.deployment).serverClientUnderBase;
  // One `..` per base segment climbs back out of `dist/client/<base>/`.
  const depth = base.split("/").length - 1;
  return nested && base ? join(distDir, "../".repeat(depth)) : distDir;
};

/**
 * Emit a `_headers` file so Netlify / Cloudflare serve the raw AI-ready
 * endpoints (`*.md`, `*.mdx`, `*.txt`) with an explicit `charset=utf-8`. Without
 * it those hosts send `text/markdown` / `text/plain` with no charset and
 * browsers fall back to Windows-1252, garbling any non-ASCII docs (#82).
 *
 * The same file carries the rest of the agent-discovery surface that only a
 * response header can express: the homepage `Link` header (RFC 8288, see
 * `ai/link-headers.ts`), and the registered media types for the extensionless
 * well-known files — `application/linkset+json` for the API catalog, the
 * signatures directory, and the Agent Skills archives. A static host serves
 * those as `octet-stream` or nothing at all without a rule.
 *
 * A `_headers` shipped in `public/` wins, exactly like `_redirects` — the opt-out
 * is checked at its source rather than in `dist`, because on Cloudflare the file
 * in `dist` is not necessarily the user's: `@astrojs/cloudflare` writes its own
 * `_headers` (an immutable `Cache-Control` rule for `/_astro/*`) during the
 * build, before this runs. Testing `dist` therefore read an adapter-generated
 * file as a user opt-out and skipped silently. When both exist, the adapter's
 * rules are preserved and ours are appended.
 *
 * Gated on {@link readsHeaderFiles}, not on `output === "static"`. A **Cloudflare
 * server** build serves `dist/client` through the Worker's ASSETS binding, and
 * Workers static assets honor `_headers` from that directory — so the file
 * applies there too, and skipping it left every Cloudflare server build with no
 * `Link` header and no media type on its own discovery files. The charset half
 * of this file *is* redundant on a server build, because the runtime endpoint
 * sets Content-Type on the Response itself; the `Link` and well-known halves are
 * not, and one conclusion about the first was applied to all three.
 *
 * Exported for the test suite, which exercises it in a subprocess like the
 * command helpers.
 */
export const emitHeaderFiles = async (
  project: BlumeProject,
  distDir: string,
  logger: ArtifactLogger
): Promise<void> => {
  const { config } = project;
  if (
    !readsHeaderFiles(config.deployment) ||
    existsSync(join(project.context.root, "public", "_headers"))
  ) {
    return;
  }
  const ours = buildNetlifyHeaders(
    config,
    buildHomeLinkHeader(config, markdownRoutePaths(project))
  );
  // An adapter may have written its own rules here already (Cloudflare adds an
  // immutable Cache-Control for /_astro/*). Keep them and append ours: both
  // sets are wanted, and `_headers` has no merge semantics beyond order.
  const target = join(assetsRoot(config, distDir), "_headers");
  const existing = existsSync(target) ? await readFile(target, "utf-8") : "";
  await writeFile(
    target,
    existing ? `${existing.trimEnd()}\n${ours}` : ours,
    "utf-8"
  );
  logger.info("Emitted _headers (UTF-8 Content-Type + homepage Link header)");
};

/**
 * Collect the Agent Skills `agents.skills` publishes, once per build, so both the
 * skills surface and llms.txt (which lists them) read the same set. Empty
 * when the feature is off, the directory is missing, nothing in it is
 * publishable (each with a warning), or a user-shipped
 * `public/.well-known/agent-skills/index.json` already owns the surface.
 */
const collectConfiguredSkills = async (
  project: BlumeProject,
  distDir: string,
  logger: ArtifactLogger
): Promise<SkillArtifact[]> => {
  const configured = project.config.agents.skills;
  if (!configured) {
    return [];
  }
  const dir = resolve(project.context.root, configured);
  if (!existsSync(dir)) {
    logger.warn(
      `agents.skills points at "${configured}" (${dir}), which does not exist; no skills published.`
    );
    return [];
  }
  if (existsSync(join(distDir, AGENT_SKILLS_DIR.slice(1), "index.json"))) {
    return [];
  }
  const { skills, warnings } = await collectSkills(dir);
  for (const warning of warnings) {
    logger.warn(warning);
  }
  if (skills.length === 0) {
    logger.warn(
      `agents.skills: no publishable skills found in "${configured}".`
    );
  }
  return skills;
};

/**
 * Publish the collected Agent Skills: copy each skill artifact under
 * `.well-known/agent-skills/` and emit the discovery index. A user-shipped
 * `public/.well-known/agent-skills/index.json` takes over the whole surface
 * (the collector returns nothing then), matching every other generated
 * artifact.
 */
const emitAgentSkills = async (
  project: BlumeProject,
  distDir: string,
  skills: readonly SkillArtifact[],
  logger: ArtifactLogger
): Promise<void> => {
  if (skills.length === 0) {
    return;
  }
  const outDir = join(distDir, AGENT_SKILLS_DIR.slice(1));
  await Promise.all(
    skills.map(async (skill) => {
      const target = join(outDir, skill.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, skill.content);
    })
  );
  await writeFile(
    join(outDir, "index.json"),
    buildSkillsIndex(skills, project.config),
    "utf-8"
  );
  logger.info(
    `Published ${skills.length} agent skill(s) (.well-known/agent-skills/index.json)`
  );
};

/**
 * Emit the generated `.well-known` discovery files — the RFC 9727 API catalog
 * and the Web Bot Auth signature directory — each skipped when the feature is
 * off or when the user ships their own copy via public/ (already in dist by
 * the time this runs).
 */
const emitWellKnownFiles = async (
  config: ResolvedConfig,
  distDir: string,
  skills: readonly SkillArtifact[],
  logger: ArtifactLogger
): Promise<void> => {
  // One document, two paths: the ai-catalog spec's well-known URI and the
  // ARD v0.91 one (see `ai/ai-catalog.ts`).
  const aiCatalog = buildAiCatalog(config, skills);
  const files = [
    {
      content: buildSignaturesDirectory(config),
      label: "Web Bot Auth",
      path: SIGNATURES_DIRECTORY_PATH,
    },
    {
      content: buildApiCatalog(config),
      label: "RFC 9727",
      path: API_CATALOG_PATH,
    },
    { content: aiCatalog, label: "AI Catalog", path: AI_CATALOG_PATH },
    { content: aiCatalog, label: "ARD manifest", path: ARD_MANIFEST_PATH },
  ];
  for (const file of files) {
    const target = join(distDir, file.path.slice(1));
    if (!file.content || existsSync(target)) {
      continue;
    }
    // Sequential by nature: both files share the .well-known dir creation.
    // oxlint-disable-next-line no-await-in-loop
    await mkdir(join(distDir, ".well-known"), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(target, file.content, "utf-8");
    logger.info(`Generated ${file.path.slice(1)} (${file.label})`);
  }
};

/**
 * Generate `llms.txt`/`llms-full.txt` into the dist dir. A user's own file in
 * `public/` (copied into dist by Astro before this runs, like the sitemap and
 * robots.txt) wins over the generated one — each file is checked and replaced
 * independently, so a custom `llms.txt` still gets a generated `llms-full.txt`.
 */
const publishLlmsFiles = async (
  project: BlumeProject,
  distDir: string,
  skills: readonly SkillArtifact[],
  logger: ArtifactLogger
): Promise<void> => {
  const indexPath = join(distDir, "llms.txt");
  const fullPath = join(distDir, "llms-full.txt");
  const writeIndex = !existsSync(indexPath);
  const writeFull = !existsSync(fullPath);
  if (!(writeIndex || writeFull)) {
    return;
  }
  const { index, full } = await buildLlmsFiles(project, { skills });
  const writes: Promise<void>[] = [];
  if (writeIndex) {
    writes.push(writeFile(indexPath, index, "utf-8"));
  }
  if (writeFull) {
    writes.push(writeFile(fullPath, full, "utf-8"));
  }
  await Promise.all(writes);
  logger.info(
    `Generated ${[
      writeIndex ? "llms.txt" : null,
      writeFull ? "llms-full.txt" : null,
    ]
      .filter(Boolean)
      .join(" and ")}`
  );
};

/**
 * Write every deploy artifact into `distDir`, the directory the platform
 * serves as static files (see the module comment). A user's own `public/`
 * file always wins. `indexSearch` is the Pagefind indexer, replaceable by
 * tests: Pagefind's in-process service cannot be reopened once a build has
 * closed it, so only one suite may run the real one.
 */
export const publishBuildArtifacts = async (
  project: BlumeProject,
  distDir: string,
  logger: ArtifactLogger,
  indexSearch: (outDir: string) => Promise<number> = buildSearchIndex
): Promise<void> => {
  if (project.config.search.provider.mode === "pagefind") {
    logger.info("Building search index");
    const indexed = await indexSearch(distDir);
    logger.info(`Indexed ${indexed} page(s) for search`);
  }

  // Upload the index to a hosted provider (Algolia, Orama Cloud, Typesense).
  // Skipped with a warning when its admin key isn't configured.
  await syncSearchProvider(project, {
    start: logger.info.bind(logger),
    success: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
  });

  // Collected once: llms.txt lists the skills the build publishes below.
  const userSkillsIndex = existsSync(
    join(distDir, AGENT_SKILLS_INDEX_PATH.slice(1))
  );
  const skills = await collectConfiguredSkills(project, distDir, logger);
  // The discovery documents advertise what this build serves: no MCP server
  // when a page took its route, no skills index when nothing was published.
  const advertised: BlumeProject = {
    ...project,
    config: advertisedConfig(project.config, {
      mcp: servesMcp(
        project,
        project.context.pagesRoot
          ? discoverPagesSync(project.context.pagesRoot)
          : []
      ),
      skills: skills.length > 0 || userSkillsIndex,
    }),
  };
  if (project.config.agents.llmsTxt.enabled) {
    await publishLlmsFiles(advertised, distDir, skills, logger);
  }

  const sitemapFiles = buildSitemapFiles(project);
  if (sitemapFiles && !existsSync(join(distDir, "sitemap.xml"))) {
    await Promise.all(
      sitemapFiles.map((file) =>
        writeFile(join(distDir, file.name), file.xml, "utf-8")
      )
    );
    logger.info(describeSitemapFiles(sitemapFiles));
  }

  const robots = buildRobots(project);
  if (robots && !existsSync(join(distDir, "robots.txt"))) {
    await writeFile(join(distDir, "robots.txt"), robots, "utf-8");
    logger.info("Generated robots.txt");
  }

  const agentReadability = buildAgentReadability(advertised);
  if (
    agentReadability &&
    !existsSync(join(distDir, "agent-readability.json"))
  ) {
    await writeFile(
      join(distDir, "agent-readability.json"),
      `${JSON.stringify(agentReadability, null, 2)}\n`,
      "utf-8"
    );
    logger.info("Generated agent-readability.json");
  }

  await emitWellKnownFiles(advertised.config, distDir, skills, logger);
  await emitAgentSkills(project, distDir, skills, logger);

  await emitRedirectFiles(advertised, distDir, logger);
  await emitHeaderFiles(advertised, distDir, logger);
};
