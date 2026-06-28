/**
 * HTTP content negotiation for the raw-Markdown variants. The `<route>.md`
 * endpoints already serve a page's source verbatim; these helpers let the dev
 * server honour `Accept: text/markdown` by transparently rewriting a page
 * request to its `.md` variant.
 */

interface AcceptEntry {
  q: number;
  type: string;
}

const parseAccept = (accept: string): AcceptEntry[] =>
  accept.split(",").map((part) => {
    const segments = part.trim().split(";");
    const type = (segments[0] ?? "").trim().toLowerCase();
    const qSegment = segments
      .slice(1)
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("q="));
    const q = qSegment ? Number.parseFloat(qSegment.slice(2)) : 1;
    return { q: Number.isNaN(q) ? 1 : q, type };
  });

/**
 * Whether the client explicitly prefers Markdown over HTML. Browsers never send
 * `text/markdown`, so an ordinary page request (`text/html`, `*​/*`) is false.
 */
export const prefersMarkdown = (accept: string | null | undefined): boolean => {
  if (!accept) {
    return false;
  }
  let markdownQ = -1;
  let htmlQ = 0;
  for (const { q, type } of parseAccept(accept)) {
    if (type === "text/markdown" || type === "text/x-markdown") {
      markdownQ = Math.max(markdownQ, q);
    } else if (type === "text/html") {
      htmlQ = Math.max(htmlQ, q);
    }
  }
  return markdownQ > 0 && markdownQ >= htmlQ;
};

/**
 * Map a page request URL to its `.md` variant, or `null` when the requested
 * path is not a known content route (Vite/Astro internals, assets, API routes,
 * landing pages, and user `.astro` pages all fall through). `routes` is the set
 * of page paths that have a raw-Markdown variant.
 */
export const markdownVariantUrl = (
  rawUrl: string | null | undefined,
  routes: ReadonlySet<string>
): string | null => {
  if (!rawUrl) {
    return null;
  }
  const queryIndex = rawUrl.indexOf("?");
  const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const pathname =
    rawPath !== "/" && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (!routes.has(pathname)) {
    return null;
  }
  const target = pathname === "/" ? "/index" : pathname;
  return `${target}.md${query}`;
};
