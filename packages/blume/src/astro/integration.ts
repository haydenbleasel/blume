import type { IncomingMessage, ServerResponse } from "node:http";

import type { AstroIntegration } from "astro";

import { markdownVariantUrl, prefersMarkdown } from "./markdown-negotiation.ts";

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
  (routes: ReadonlySet<string>) =>
  (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      prefersMarkdown(req.headers.accept)
    ) {
      const variant = markdownVariantUrl(req.url, routes);
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
      // Prepend so the rewrite happens before Astro's own request handler,
      // letting the rewritten URL resolve to the `.md` endpoint.
      server.middlewares.stack.unshift({
        handle: negotiateMarkdown(new Set(options.contentRoutes)),
        route: "",
      });
    },
  },
  name: "blume",
});
