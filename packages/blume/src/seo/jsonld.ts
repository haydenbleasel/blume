import type { Crumb } from "../components/layout/nav-utils.ts";
import { normalizeBasePath, withBasePath } from "../core/base-path.ts";

/** A date-ish value carried through frontmatter (string, YAML Date, or unset). */
type DateInput = string | Date | null;

/** Inputs for a page's JSON-LD, all known at render time in RootLayout. */
export interface StructuredDataInput {
  siteName: string;
  /** Absolute site origin, or null when `deployment.site` is unset. */
  siteUrl: string | null;
  title: string;
  description?: string;
  /** Page route, e.g. `/blog/post`. */
  route: string;
  /** Deployment base (`import.meta.env.BASE_URL`); prefixed onto absolute URLs. */
  base?: string;
  /** Content type — `blog` and `changelog` map to richer article types. */
  pageType?: string;
  /** Publish date (string or YAML Date); emitted as ISO `datePublished`. */
  published?: DateInput;
  /** Last-modified date; emitted as ISO `dateModified`. */
  modified?: DateInput;
  /** BCP-47 language tag for `inLanguage`; defaults to `en`. */
  locale?: string;
  breadcrumbs: Crumb[];
}

/** schema.org `@type` for each content type; defaults to TechArticle. */
const ARTICLE_TYPES: Record<string, string> = {
  blog: "BlogPosting",
  changelog: "TechArticle",
};

const trimSlash = (value: string): string => value.replace(/\/$/u, "");

const absolute = (base: string | null, path: string): string =>
  base ? `${base}${path}` : path;

/**
 * Frontmatter date → ISO 8601, or undefined when absent/unparseable. Shared with
 * the layout's `article:published_time`/`article:modified_time` so both date
 * surfaces treat a malformed date the same way: omit it rather than emit
 * "Invalid Date".
 */
export const toIso = (value: DateInput | undefined): string | undefined => {
  if (!value) {
    return;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * Build a schema.org JSON-LD `@graph` for a page: site identity, the page as an
 * article, and its breadcrumb trail. Returns null when there is nothing useful
 * to emit (e.g. the homepage without a configured site). URLs are absolute when
 * `siteUrl` is set, otherwise route-relative.
 */
export const buildStructuredData = (
  input: StructuredDataInput
): Record<string, unknown> | null => {
  const base = input.siteUrl ? trimSlash(input.siteUrl) : null;
  // Routes carry `basePath`; a `deployment.base` subdirectory is layered on top
  // so JSON-LD URLs match the served location.
  const deployBase = normalizeBasePath(input.base);
  const pageUrl = absolute(base, withBasePath(deployBase, input.route));
  const rootUrl = absolute(base, deployBase);
  const graph: Record<string, unknown>[] = [];

  if (base) {
    graph.push({
      "@id": `${base}#website`,
      "@type": "WebSite",
      name: input.siteName,
      url: rootUrl,
    });
  }

  // The homepage is fully described by the WebSite node; deeper pages get an
  // article node plus a breadcrumb trail.
  if (input.route !== "/") {
    const node: Record<string, unknown> = {
      "@id": `${pageUrl}#page`,
      "@type": ARTICLE_TYPES[input.pageType ?? ""] ?? "TechArticle",
      headline: input.title,
      inLanguage: input.locale || "en",
      name: input.title,
      url: pageUrl,
    };
    if (input.description) {
      node.description = input.description;
    }
    const published = toIso(input.published);
    if (published) {
      node.datePublished = published;
    }
    const modified = toIso(input.modified);
    if (modified) {
      node.dateModified = modified;
    }
    if (base) {
      node.isPartOf = { "@id": `${base}#website` };
    }
    graph.push(node);

    // Google requires `item` on every ListItem except the last; sidebar groups
    // without an index page produce route-less crumbs, so those are dropped
    // (positions renumbered) rather than emitted as invalid link-less items.
    const linked = input.breadcrumbs.filter(
      (crumb): crumb is Required<Crumb> => typeof crumb.route === "string"
    );
    if (linked.length > 1) {
      graph.push({
        "@type": "BreadcrumbList",
        itemListElement: linked.map((crumb, index) => ({
          "@type": "ListItem",
          item: absolute(base, withBasePath(deployBase, crumb.route)),
          name: crumb.label,
          position: index + 1,
        })),
      });
    }
  }

  if (graph.length === 0) {
    return null;
  }
  return { "@context": "https://schema.org", "@graph": graph };
};
