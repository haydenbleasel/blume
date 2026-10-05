import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";

import { join } from "pathe";

import { crossOriginDiscoveryPaths } from "../ai/ai-catalog.ts";
import {
  API_CATALOG_PATH,
  API_CATALOG_TYPE,
  hasApiCatalog,
} from "../ai/api-catalog.ts";
import {
  SIGNATURES_DIRECTORY_PATH,
  SIGNATURES_DIRECTORY_TYPE,
} from "../ai/web-bot-auth.ts";
import { normalizeBasePath, normalizePath } from "../core/base-path.ts";
import { POWERED_BY_HEADERS } from "../core/powered-by.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { compileRedirects, isPatternPath } from "../core/redirect-patterns.ts";
import type { CompiledRedirect } from "../core/redirect-patterns.ts";
import type { ResolvedConfig } from "../core/schema.ts";
import { SVG_ASSET_HEADERS, svgAssetPath } from "./headers.ts";
import { distDir } from "./platforms/paths.ts";
import type { BuildLog } from "./platforms/types.ts";
import { platformRedirects } from "./redirects.ts";

/**
 * The response headers the Node standalone server can't set itself. Its static
 * handler (`send`) types a file by its extension alone and sends no CORS
 * header, so the extensionless well-known files go out as
 * `application/octet-stream` and a registry reading the discovery documents
 * from another origin is blocked — the half of the `_headers` rules
 * (`deploy/headers.ts`) that a Node server has no file to read from. The Markdown
 * and text charsets need no rule here: `send` already adds `charset=UTF-8` to
 * `text/*` types.
 *
 * The same wrapper answers the configured redirects. Astro's own handler
 * honors a redirect's configured status only when its destination resolves
 * to a discrete route, and Blume serves every page from `[...slug]`, so a
 * `302` or `307` would go out as a `301` or `308` — permanent redirects that
 * browsers cache.
 */

/** The headers one exact served path (deployment base included) gets. */
export interface NodeHeaderRule {
  headers: Record<string, string>;
  path: string;
}

/** The server entry `@astrojs/node` writes, which the wrapper takes over. */
export const NODE_ENTRY_FILE = "entry.mjs";
/** Where Astro's own entry moves, beside the wrapper that imports it. */
export const NODE_ASTRO_ENTRY_FILE = "astro-entry.mjs";
/** First line of the wrapper, so a second pass over the same build is a no-op. */
const WRAPPER_MARKER = "// blume:node-headers";

/** The header rules for this config, merged per path. */
export const nodeHeaderRules = (config: ResolvedConfig): NodeHeaderRule[] => {
  const deployBase = normalizeBasePath(config.deployment.options.base);
  const byPath = new Map<string, Record<string, string>>();
  const add = (path: string, name: string, value: string): void => {
    byPath.set(path, { ...byPath.get(path), [name]: value });
  };
  if (hasApiCatalog(config)) {
    add(API_CATALOG_PATH, "Content-Type", API_CATALOG_TYPE);
  }
  if (config.agents.webBotAuth.keys.length > 0) {
    add(SIGNATURES_DIRECTORY_PATH, "Content-Type", SIGNATURES_DIRECTORY_TYPE);
  }
  for (const path of crossOriginDiscoveryPaths(config)) {
    add(path, "Access-Control-Allow-Origin", "*");
  }
  return [...byPath].map(([path, headers]) => ({
    headers,
    path: `${deployBase}${path}`,
  }));
};

/** Exact-path rules, as `[path, headers]` pairs for the wrapper's lookup. */
const exactRules = (
  rules: readonly NodeHeaderRule[]
): [string, Record<string, string>][] =>
  rules
    .filter((rule) => !rule.path.includes("*"))
    .map((rule) => [rule.path, rule.headers]);

/**
 * Glob rules (`/blume-assets/*.svg`), as `[prefix, suffix, headers]` — the
 * text before and after the one `*`, which spans path segments.
 */
const patternRules = (
  rules: readonly NodeHeaderRule[]
): [string, string, Record<string, string>][] =>
  rules
    .filter((rule) => rule.path.includes("*"))
    .map((rule) => {
      const star = rule.path.indexOf("*");
      return [
        rule.path.slice(0, star),
        rule.path.slice(star + 1),
        rule.headers,
      ];
    });

/**
 * The configured redirects the wrapper answers, keyed by served path (the
 * trailing slash trimmed), each to its `Location` and exact status.
 */
export type NodeRedirects = Record<string, [string, number]>;

/**
 * The configured exact redirects, based the way the host matches them (see
 * `platformRedirects`) and keyed for the wrapper's lookup, the `Location`
 * percent-encoded as Astro sends it. A redirect at a content route's own path
 * is left out: the prerendered page owns that URL, and the static handler
 * serves it before Astro's redirect ever could. Patterns are compiled apart
 * ({@link nodePatternRedirects}).
 */
export const nodeRedirects = (project: BlumeProject): NodeRedirects => {
  const { config } = project;
  if (config.redirects.length === 0) {
    return {};
  }
  const base = normalizeBasePath(config.deployment.options.base);
  const pages = new Set(
    project.manifest.routes.map((route) =>
      normalizePath(`${base}${route.path}`)
    )
  );
  return Object.fromEntries(
    platformRedirects(project)
      .filter(
        (redirect) =>
          !(
            isPatternPath(redirect.from) ||
            pages.has(normalizePath(redirect.from))
          )
      )
      .map((redirect) => [
        normalizePath(redirect.from),
        [encodeURI(redirect.to), redirect.status],
      ])
  );
};

/**
 * The configured pattern redirects (`/beta/:slug*`), based the way the host
 * matches them and compiled for the wrapper, which tries them in order after
 * the exact ones. None can match a page: the scan rejects a pattern that
 * does (`BLUME_REDIRECT_MATCHES_PAGE`).
 */
export const nodePatternRedirects = (
  project: BlumeProject
): CompiledRedirect[] =>
  project.config.redirects.length === 0
    ? []
    : compileRedirects(platformRedirects(project));

/** What the wrapper needs beyond the header rules. */
export interface NodeEntryOptions {
  /** `deployment.base`, normalized (`""` at the root). */
  base?: string;
  /** Whether responses identify Blume with `X-Powered-By`. Defaults to `true`. */
  poweredBy?: boolean;
  /** The configured redirects, from {@link nodeRedirects}. */
  redirects?: NodeRedirects;
  /** The configured pattern redirects, from {@link nodePatternRedirects}. */
  patternRedirects?: CompiledRedirect[];
}

/**
 * The entry that replaces Astro's: it answers a configured redirect with its
 * exact status, and otherwise stamps the rules' headers on the response and
 * hands the request to Astro's handler. `send` leaves a Content-Type that is
 * already set alone, so the registered media type wins. Unless `poweredBy` is
 * `false`, every answer also names Blume in `X-Powered-By` — the redirects,
 * and the prerendered pages and files the static handler serves, which
 * Blume's runtime middleware never sees. A middleware-mode entry leaves that
 * header to the middleware: Astro hands a request it has no route for back to
 * the host app through `next()`, and that response is the host's own.
 *
 * A rule matches the file the static handler will serve, not the raw URL:
 * Astro strips the base when it leads the path and serves the rest from the
 * client directory either way, and `send` decodes and normalizes the path —
 * so `/docs/blume-assets/a.sv%67`, `/blume-assets/a.svg`, and
 * `/docs//x/../blume-assets/a.svg` are all the same SVG. The comparison
 * ignores case, as a case-insensitive disk and `send`'s MIME lookup do.
 *
 * It keeps Astro's contract — the `handler`, `options`, and `startServer`
 * exports `astro preview` and a middleware-mode host import — and its
 * autostart: Astro's entry is imported with autostart off (the env var is read
 * when that module evaluates, so the import has to be dynamic), and the
 * wrapper starts the server itself, taking over its request listener so a
 * redirect is answered before Astro sees the request.
 */
export const nodeEntryWrapper = (
  rules: readonly NodeHeaderRule[],
  options: NodeEntryOptions = {}
): string =>
  `${WRAPPER_MARKER}
// Written by \`blume build\`: Astro's server entry is ./${NODE_ASTRO_ENTRY_FILE}.
// This wrapper answers the configured redirects with their exact status and
// sets the headers the standalone server's static handler can't (the media
// types and CORS headers of the .well-known discovery files, the sandbox on
// downloaded SVGs, X-Powered-By), then hands every other request to Astro.
import { posix } from "node:path";

const BASE = ${JSON.stringify(options.base ?? "")};
const POWERED_BY = ${JSON.stringify(options.poweredBy === false ? {} : POWERED_BY_HEADERS)};
const RULES = new Map(${JSON.stringify(exactRules(rules))});
const PATTERNS = ${JSON.stringify(patternRules(rules))};
const REDIRECTS = ${JSON.stringify(options.redirects ?? {})};
const PATTERN_REDIRECTS = ${JSON.stringify(options.patternRedirects ?? [])}.map(
  ([source, location, status]) => [new RegExp(source, "u"), location, status]
);
const safeDecode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};
const urlPath = (req) => (req.url ?? "").split("#")[0].split("?")[0];
// The file the static handler serves for a request, spelled with the base.
const servedPath = (req) => {
  const path = posix.normalize("/" + safeDecode(urlPath(req)));
  const rest =
    BASE && (path === BASE || path.startsWith(BASE + "/"))
      ? path.slice(BASE.length)
      : path;
  return BASE + (rest || "/");
};
const applyHeaders = (req, res, identify) => {
  const path = servedPath(req);
  const lower = path.toLowerCase();
  const headers = {
    ...(identify ? POWERED_BY : {}),
    ...(RULES.get(path) ??
      PATTERNS.find(
        ([prefix, suffix]) =>
          lower.startsWith(prefix.toLowerCase()) &&
          lower.endsWith(suffix.toLowerCase())
      )?.[2]),
  };
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
};
// A pattern redirect's Location: its template, each $n filled with that
// capture, encoded so it can't grow a query or fragment.
const fillLocation = (location, match) =>
  location.replace(/\\$(\\d+)/gu, (_reference, index) =>
    encodeURI(match[Number(index)] ?? "")
      .replaceAll("?", "%3F")
      .replaceAll("#", "%23")
  );
// The configured redirect for a decoded path: an exact one, else the first
// pattern that matches it.
const redirectFor = (path) => {
  const trimmed = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
  if (Object.hasOwn(REDIRECTS, trimmed)) {
    return REDIRECTS[trimmed];
  }
  for (const [pattern, location, status] of PATTERN_REDIRECTS) {
    const match = pattern.exec(path);
    if (match) {
      return [fillLocation(location, match), status];
    }
  }
  return null;
};
// Answer a configured redirect with its exact status; Astro's handler would
// send a 301 (a 308 for other methods) whatever the configured one.
const answerRedirect = (req, res) => {
  const redirect = redirectFor(safeDecode(urlPath(req)));
  if (redirect === null) {
    return false;
  }
  const [location, status] = redirect;
  res.writeHead(status, { ...POWERED_BY, location });
  res.end();
  return true;
};
const previous = process.env.ASTRO_NODE_AUTOSTART;
process.env.ASTRO_NODE_AUTOSTART = "disabled";
const astro = await import("./${NODE_ASTRO_ENTRY_FILE}");
if (previous === undefined) {
  delete process.env.ASTRO_NODE_AUTOSTART;
} else {
  process.env.ASTRO_NODE_AUTOSTART = previous;
}
export const { options } = astro;
export const handler = (req, res, ...rest) => {
  if (answerRedirect(req, res)) {
    return;
  }
  applyHeaders(req, res, options.mode !== "middleware");
  return astro.handler(req, res, ...rest);
};
export const startServer = () => {
  const started = astro.startServer();
  // Take over the adapter's request listener only where it exposes its HTTP
  // server as expected; a different shape serves without the headers and
  // redirect statuses rather than failing to start.
  const httpServer = started?.server?.server;
  if (typeof httpServer?.listeners === "function") {
    const astroListeners = httpServer.listeners("request");
    httpServer.removeAllListeners("request");
    httpServer.on("request", (req, res) => {
      if (answerRedirect(req, res)) {
        return;
      }
      applyHeaders(req, res, true);
      for (const listener of astroListeners) {
        listener.call(httpServer, req, res);
      }
    });
  }
  return started;
};
if (options.mode === "standalone" && previous !== "disabled") {
  startServer();
}
`;

/**
 * Put the wrapper in front of a Node server build's entry. A build with
 * `poweredBy` off, no rule (no API catalog, AI catalog, MCP server,
 * signatures directory, or downloaded content assets), and no redirect leaves
 * Astro's entry alone.
 */
export const wrapNodeEntry = async (
  project: BlumeProject,
  log: BuildLog
): Promise<void> => {
  // Content assets a CMS source downloaded ship as static files, which the
  // standalone server serves without the SVG sandbox static hosts get from
  // `_headers`; only a build that has them needs the rule.
  const assetsDir = join(distDir(project.context), "client", "blume-assets");
  const rules = [
    ...nodeHeaderRules(project.config),
    ...(existsSync(assetsDir)
      ? [
          {
            headers: { ...SVG_ASSET_HEADERS },
            path: svgAssetPath(project.config),
          },
        ]
      : []),
  ];
  const redirects = nodeRedirects(project);
  const patternRedirects = nodePatternRedirects(project);
  if (
    !project.config.poweredBy &&
    rules.length === 0 &&
    Object.keys(redirects).length === 0 &&
    patternRedirects.length === 0
  ) {
    return;
  }
  const serverDir = join(distDir(project.context), "server");
  const entry = join(serverDir, NODE_ENTRY_FILE);
  if (!existsSync(entry)) {
    log.warn(
      `Could not find the Node server entry at ${entry}, so the server runs without the headers and redirect statuses Blume sets there.`
    );
    return;
  }
  const source = await readFile(entry, "utf-8");
  if (source.startsWith(WRAPPER_MARKER)) {
    return;
  }
  await rename(entry, join(serverDir, NODE_ASTRO_ENTRY_FILE));
  await writeFile(
    entry,
    nodeEntryWrapper(rules, {
      base: normalizeBasePath(project.config.deployment.options.base),
      patternRedirects,
      poweredBy: project.config.poweredBy,
      redirects,
    }),
    "utf-8"
  );
  log.success("Wired headers and redirects into the Node server entry");
};
