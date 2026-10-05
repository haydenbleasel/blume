/**
 * The header that names Blume as the framework behind a response, sent unless
 * `poweredBy` is `false`. The dev server and Blume's runtime middleware
 * (`components/powered-by-middleware.ts`) send it, and so does every host
 * for the built site: static hosts through `deploy/headers.ts`'s rules,
 * server builds through each platform's own mechanism (`deploy/platforms`).
 * It lives apart from those modules so the runtime middleware can import it
 * without pulling in the deploy code.
 */
export const POWERED_BY_HEADERS = {
  "X-Powered-By": "Blume",
} satisfies Record<string, string>;
