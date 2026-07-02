import type { IncomingMessage, ServerResponse } from "node:http";

import type { AstroIntegration } from "astro";

import { enrichDiagnostic } from "../core/diagnostics.ts";
import type { Diagnostic } from "../core/types.ts";
import { markdownVariantUrl, prefersMarkdown } from "./markdown-negotiation.ts";

/** The dev server's HMR channel — either `.ws` (Vite ≤5) or `.hot` (Vite 6+). */
interface OverlayChannel {
  send: (payload: unknown) => void;
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
  const errors = diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map(enrichDiagnostic);
  const channel = overlayChannel();
  if (errors.length === 0 || !channel) {
    return;
  }
  const body = errors
    .map((diagnostic) => {
      const where = diagnostic.file
        ? `\n  at ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
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
}

/**
 * Dev-server content negotiation: when a client asks for `text/markdown`,
 * transparently rewrite a content-page request to its `.md` variant so the
 * existing raw-Markdown endpoint serves it. Runs only under `blume dev`; static
 * and server builds expose the same content at the `.md` URL. Only routes with
 * a Markdown variant are rewritten, so landing pages and user `.astro` pages
 * keep serving HTML.
 */
const negotiateMarkdown =
  (routes: ReadonlySet<string>, base?: string) =>
  (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      prefersMarkdown(req.headers.accept)
    ) {
      const variant = markdownVariantUrl(req.url, routes, base);
      if (variant) {
        res.setHeader("Vary", "Accept");
        req.url = variant;
      }
    }
    next();
  };

/**
 * Blume's Astro integration. Mounts user-authored pages from `pages/` into the
 * generated runtime via `injectRoute`, keeping each file in its original
 * location so relative imports and `getStaticPaths` keep working, and teaches
 * the dev server to honour `Accept: text/markdown`.
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
      overlayServer = server as unknown as OverlayServer;
      // Prepend so the rewrite happens before Astro's own request handler,
      // letting the rewritten URL resolve to the `.md` endpoint.
      server.middlewares.stack.unshift({
        handle: negotiateMarkdown(new Set(options.contentRoutes), options.base),
        route: "",
      });
    },
  },
  name: "blume",
});
