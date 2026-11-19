import { ERROR_ROUTES } from "../audit/types.ts";

/**
 * Content types that are dated writing: blog posts and changelog entries.
 * They take `og:type: article` (with `article:*` timestamps), and an article
 * `@type` in JSON-LD; everything else is a `website`.
 */
const ARTICLE_PAGE_TYPES: ReadonlySet<string> = new Set(["blog", "changelog"]);

/** The page's `og:type` for its content type. */
export const ogTypeFor = (pageType?: string): "article" | "website" =>
  pageType !== undefined && ARTICLE_PAGE_TYPES.has(pageType)
    ? "article"
    : "website";

/** What decides whether a custom page has a Markdown copy. */
export interface CustomMirrorInput {
  /** Whether the page's route has a dynamic (`[param]`) segment. */
  dynamic: boolean;
  /** PageLayout's `ai.exclude`. */
  excluded: boolean;
  noindex: boolean;
  /** The page's route, without the deployment base. */
  route: string;
}

/**
 * The name a custom page's Markdown copy is served under, or null when it has
 * none. The homepage always has one (`/index`: the `llms.txt` index stands in
 * for a landing page, see `buildRawMarkdown`). Any other static page the build
 * reads back gets one at its own route (see `ai/built-pages.ts`), unless it is
 * `noindex`, excluded from the agent surfaces, or an error page.
 */
export const customMirrorName = (input: CustomMirrorInput): string | null => {
  if (input.route === "/") {
    return "/index";
  }
  return input.dynamic ||
    input.excluded ||
    input.noindex ||
    ERROR_ROUTES.has(input.route)
    ? null
    : input.route;
};
