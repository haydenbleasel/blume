import type { IncomingMessage, ServerResponse } from "node:http";

import type { AstroIntegration } from "astro";

import { enrichDiagnostic } from "../core/diagnostics.ts";
import type { Diagnostic } from "../core/types.ts";
import { markdownVariantUrl, prefersMarkdown } from "./markdown-negotiation.ts";

/** The `{ type: "error" }` payload Vite's browser overlay renders. */
interface OverlayErrorPayload {
  err: {
    id?: string;
    message: string;
    plugin: string;
    stack: string;
  };
  type: "error";
}

/** The dev server's HMR channel — either `.ws` (Vite ≤5) or `.hot` (Vite 6+). */
interface OverlayChannel {
  send: (payload: OverlayErrorPayload) => void;
}
interface OverlayServer {
  hot?: OverlayChannel;
  ws?: OverlayChannel;
}

// Set on `astro:server:setup`; read by `showBlumeErrorOverlay` so the CLI's
// regeneration can push Blume diagnostics into Vite's browser error overlay.
// Same-process module singleton (dev and the integration share the instance).
let overlayServer: OverlayServer | null = null;

const overlayChannel = (): OverlayChannel | undefined =>
  overlayServer?.ws ?? overlayServer?.hot;

/**
 * Surface Blume's own diagnostics (config/frontmatter/content errors) in the
 * Vite/Astro browser error overlay during `blume dev`, so they don't hide in the
 * terminal. A no-op when there are no errors or the dev server isn't up. The
 * overlay clears itself on the next successful HMR update.
 */
export const showBlumeErrorOverlay = (diagnostics: Diagnostic[]): void => {
  const errors: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      errors.push(enrichDiagnostic(diagnostic));
    }
  }
  const channel = overlayChannel();
  if (errors.length === 0 || !channel) {
    return;
  }
  const body = errors
    .map((diagnostic) => {
      const lineSuffix = diagnostic.line ? `:${diagnostic.line}` : "";
      const where = diagnostic.file
        ? `\n  at ${diagnostic.file}${lineSuffix}`
        : "";
      const fix = diagnostic.suggestion
        ? `\n  fix: ${diagnostic.suggestion}`
        : "";
      const docs = diagnostic.docsUrl ? `\n  docs: ${diagnostic.docsUrl}` : "";
      return `[${diagnostic.code}] ${diagnostic.message}${where}${fix}${docs}`;
    })
    .join("\n\n");
  channel.send({
    err: {
      id: errors[0]?.file,
      message: `Blume found ${errors.length} error(s):\n\n${body}`,
      plugin: "blume",
      stack: "",
    },
    type: "error",
  });
};

/** A user page mounted into the generated runtime. */
export interface BlumePageRoute {
  /** Route pattern, e.g. `/changelog` or `/examples/[slug]`. */
  pattern: string;
  /** Absolute path to the user's `.astro` page file. */
  entrypoint: string;
}

export interface BlumeIntegrationOptions {
  pages: BlumePageRoute[];
  /** Page routes that have a raw-Markdown variant (the content manifest). */
  contentRoutes: string[];
  /** Configured `deployment.base`, stripped from dev URLs before matching. */
  base?: string;
  /**
   * Homepage `Link` header value for agent discovery (see
   * `ai/link-headers.ts`); the dev-server counterpart of the `_headers` /
   * Vercel-config emission, so `curl -I` against `blume dev` shows what the
   * deployed site will send.
   */
  homeLinkHeader?: string;
}

/**
 * Whether a dev-server request URL is the homepage: the path (query dropped,
 * `deployment.base` stripped, trailing slash tolerated) is the root.
 */
const isHomeUrl = (rawUrl: string | undefined, base?: string): boolean => {
  if (!rawUrl) {
    return false;
  }
  const queryIndex = rawUrl.indexOf("?");
  let path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const prefix = base && base !== "/" ? base.replace(/\/$/u, "") : "";
  if (prefix) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      return false;
    }
    path = path.slice(prefix.length);
  }
  return path === "" || path === "/";
};

/**
 * Dev-server content negotiation: when a client asks for `text/markdown`,
 * transparently rewrite a content-page request to its `.md` variant so the
 * existing raw-Markdown endpoint serves it. Runs only under `blume dev` — in
 * production the content pages are prerendered and served from the platform's
 * static layer, which this middleware never fronts. Vercel server builds get
 * the same negotiation from routing rules spliced into the Build Output config
 * (see `deploy/vercel-negotiation.ts`), Cloudflare server builds from a
 * wrapper Worker routed to by `assets.run_worker_first` (see
 * `deploy/cloudflare-negotiation.ts`); every other build exposes the same
 * content at the `.md` URL. Only routes with a Markdown variant are rewritten,
 * so user `.astro` pages keep serving HTML — except the homepage, whose
 * variant falls back to the synthesized llms.txt mirror when it's a landing
 * page (see `markdownRoutePaths`). The same
 * middleware also stamps the homepage agent-discovery `Link` header, mirroring
 * what the deployed site sends via `_headers` / the Vercel routing config.
 */
const negotiateMarkdown =
  (routes: ReadonlySet<string>, base?: string, homeLinkHeader?: string) =>
  (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.method === "GET" || req.method === "HEAD") {
      if (homeLinkHeader && isHomeUrl(req.url, base)) {
        res.setHeader("Link", homeLinkHeader);
      }
      if (prefersMarkdown(req.headers.accept)) {
        const variant = markdownVariantUrl(req.url, routes, base);
        if (variant) {
          res.setHeader("Vary", "Accept");
          req.url = variant;
        }
      }
    }
    next();
  };

/**
 * Blume's Astro integration. Mounts user-authored pages from `pages/` into the
 * generated runtime via `injectRoute`, keeping each file in its original
 * location so relative imports and `getStaticPaths` keep working, and teaches
 * the dev server to honor `Accept: text/markdown`.
 */
export const blumeIntegration = (
  options: BlumeIntegrationOptions
): AstroIntegration => ({
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      for (const page of options.pages) {
        injectRoute({
          entrypoint: page.entrypoint,
          pattern: page.pattern,
          prerender: true,
        });
      }
    },
    "astro:server:setup": ({ server }) => {
      // Keep a handle on the dev server so Blume diagnostics can be pushed to
      // its browser error overlay (see `showBlumeErrorOverlay`).
      overlayServer = server;
      // Prepend so the rewrite happens before Astro's own request handler,
      // letting the rewritten URL resolve to the `.md` endpoint.
      server.middlewares.stack.unshift({
        handle: negotiateMarkdown(
          new Set(options.contentRoutes),
          options.base,
          options.homeLinkHeader
        ),
        route: "",
      });
    },
  },
  name: "blume",
});
