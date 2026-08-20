import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type { CheckModule, PageSnapshot } from "../types.ts";
import { normalizePath } from "../url.ts";

/** The Open Graph properties a share card is unusable without. */
const OG_REQUIRED = ["og:title", "og:type", "og:description"];

/**
 * `og:url` must be an absolute URL, so Blume can only emit it once
 * `deployment.site` is known. Requiring it on a site that hasn't set one would
 * report the same missing config on every page; SITE_NOT_SET says it once.
 */
const ogRequired = (hasSite: boolean): string[] =>
  hasSite ? [...OG_REQUIRED, "og:url"] : OG_REQUIRED;

/**
 * Open Graph and X (Twitter) card tags.
 *
 * Ahrefs splits each of these into "missing" and "incomplete". That's a
 * distinction without a difference — a card with no tags and a card with half
 * its tags both fail to render — so each is one check that names exactly which
 * properties are absent.
 */
export const socialChecks: CheckModule = {
  category: "social",
  run(context) {
    const found: Diagnostic[] = [];
    const hasSite = Boolean(context.project.config.deployment.site);
    const required = ogRequired(hasSite);

    for (const page of context.pages) {
      // Error pages are never shared, so their cards don't matter.
      if (!page.indexable) {
        continue;
      }

      const missing = required.filter((property) => !page.og[property]);
      if (missing.length > 0) {
        found.push(
          finding(
            "BLUME_AUDIT_OG_INCOMPLETE",
            pageSite(context, page, ["description"]),
            missing.length === required.length
              ? "Page has no Open Graph tags."
              : `Open Graph is missing ${missing.join(", ")}.`
          )
        );
      }

      // The generated OG card is served from an absolute URL, so it too depends
      // on `deployment.site`; SITE_NOT_SET already covers that case.
      if (hasSite && !page.og["og:image"]) {
        found.push(
          finding(
            "BLUME_AUDIT_OG_IMAGE_MISSING",
            pageSite(context, page, ["seo", "image"]),
            "Page has no og:image — shares will render without a preview card."
          )
        );
      }

      const ogUrl = page.og["og:url"];
      if (ogUrl && page.canonical && ogUrl !== page.canonical) {
        found.push(
          finding(
            "BLUME_AUDIT_OG_URL_MISMATCH",
            pageSite(context, page),
            `og:url is ${ogUrl} but the canonical is ${page.canonical}.`
          )
        );
      }

      // X reads title/description/image from the Open Graph tags, so the only
      // thing it can't infer is the card type and the account attribution.
      if (!page.twitter["twitter:card"]) {
        found.push(
          finding(
            "BLUME_AUDIT_TWITTER_CARD_INCOMPLETE",
            pageSite(context, page),
            "Page has no twitter:card — X will render a plain link, not a card."
          )
        );
      }
    }
    return found;
  },
  tier: "static",
};

/** The JSON-LD keywords the audit reads off a parsed block. */
interface JsonLdNode {
  "@context"?: unknown;
  "@graph"?: unknown;
  "@type"?: unknown;
}

/** Whether one parsed JSON-LD value is an object the keyword checks can read. */
const isJsonLdNode = (
  value: PageSnapshot["jsonld"][number]
): value is JsonLdNode => typeof value === "object" && value !== null;

/**
 * What's missing from one JSON-LD block.
 *
 * A block may either be a single node (`{@context, @type, …}`) or a `@graph`
 * container (`{@context, @graph: [{@type, …}, …]}`), which is the shape Blume
 * itself emits. In the container form `@context` is declared once at the root
 * and each entry carries its own `@type` — so demanding `@type` on the root, or
 * `@context` on each entry, would flag perfectly valid structured data.
 */
const jsonLdProblems = (node: PageSnapshot["jsonld"][number]): string[] => {
  if (!isJsonLdNode(node)) {
    return ["it is not an object"];
  }
  const problems: string[] = [];
  if (!node["@context"]) {
    problems.push("@context");
  }

  const graph = node["@graph"];
  if (Array.isArray(graph)) {
    const untyped = graph.filter(
      (entry) => !isJsonLdNode(entry) || !entry["@type"]
    ).length;
    if (untyped > 0) {
      problems.push(`@type on ${untyped} of its ${graph.length} @graph nodes`);
    }
  } else if (!node["@type"]) {
    problems.push("@type");
  }

  return problems;
};

/** Structured data. We validate what Blume emits, and don't pretend to do more. */
export const structuredDataChecks: CheckModule = {
  category: "structured-data",
  run(context) {
    const found: Diagnostic[] = [];
    for (const page of context.pages) {
      for (const error of page.jsonldErrors) {
        found.push(
          finding(
            "BLUME_AUDIT_JSONLD_INVALID",
            pageSite(context, page),
            `A JSON-LD block failed to parse: ${error}`
          )
        );
      }

      for (const node of page.jsonld) {
        const problems = jsonLdProblems(node);
        if (problems.length > 0) {
          found.push(
            finding(
              "BLUME_AUDIT_JSONLD_INCOMPLETE",
              pageSite(context, page),
              `A JSON-LD block is missing ${problems.join(" and ")}.`
            )
          );
        }
      }
    }
    return found;
  },
  tier: "static",
};

/** What makes a slug untidy, with the human name for each offense. */
const URL_STYLE: { name: string; test: RegExp }[] = [
  { name: "uppercase letters", test: /[A-Z]/u },
  { name: "underscores", test: /_/u },
  { name: "spaces", test: /%20| /u },
];

/** A protocol-relative URL names a dotted host (`//cdn.example.com/x`). */
const DOTTED_HOST = /^\/\/[^/]*\./u;

/**
 * Whether an href carries a doubled slash from a trailing-slash `basePath` /
 * `deployment.base`. `//docs/x` is the telltale: a browser reads it as a
 * protocol-relative URL with host `docs`, so the link silently leaves the site
 * — and every link checker skips it as external. An interior `//` (`/docs//x`)
 * is the same mistake composed mid-path.
 */
const doubledSlash = (href: string): boolean => {
  if (href.startsWith("//")) {
    return !DOTTED_HOST.test(href);
  }
  if (!href.startsWith("/")) {
    return false;
  }
  // Only the path — a query param may legitimately carry a URL.
  const [path] = href.split(/[?#]/u);
  return (path ?? "").includes("//");
};

export const urlChecks: CheckModule = {
  category: "links",
  run(context) {
    const found: Diagnostic[] = [];
    /** Doubled hrefs are site-wide (a bad base) — one finding per target. */
    const doubled = new Map<string, PageSnapshot>();
    for (const page of context.pages) {
      if (page.url.includes("//")) {
        found.push(
          finding(
            "BLUME_AUDIT_DOUBLE_SLASH_URL",
            pageSite(context, page),
            `URL ${normalizePath(page.url)} contains a double slash.`
          )
        );
      }
      for (const link of page.links) {
        const href = link.href.trim();
        if (doubledSlash(href) && !doubled.has(href)) {
          doubled.set(href, page);
        }
      }

      const untidy = URL_STYLE.filter((style) => style.test.test(page.url));
      if (untidy.length > 0) {
        found.push(
          finding(
            "BLUME_AUDIT_URL_STYLE",
            pageSite(context, page),
            `URL ${page.url} contains ${untidy.map((style) => style.name).join(" and ")}.`
          )
        );
      }
    }
    for (const [href, page] of doubled) {
      found.push(
        finding(
          "BLUME_AUDIT_DOUBLE_SLASH_URL",
          pageSite(context, page),
          `Link to ${href} contains a double slash.`
        )
      );
    }
    return found;
  },
  tier: "static",
};
