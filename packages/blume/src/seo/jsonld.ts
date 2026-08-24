import type { Crumb } from "../components/layout/nav-utils.ts";
import { normalizeBasePath, withBasePath } from "../core/base-path.ts";

/** A date-ish value carried through frontmatter (string, YAML Date, or unset). */
type DateInput = string | Date | null;

/** A schema.org `PostalAddress`; every part optional. */
export interface PostalAddressIdentity {
  addressCountry?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  streetAddress?: string;
}

/**
 * `seo.organization`: the organization behind the site, emitted on every page
 * as an `Organization` node the WebSite and article nodes cite as publisher.
 */
export interface OrganizationIdentity {
  address?: PostalAddressIdentity;
  /** `ContactPoint.contactType`; only emitted with an email or telephone. */
  contactType: string;
  email?: string;
  /** Absolute URL or root-relative path (absolutized like page URLs). */
  logo?: string;
  /** Defaults to the site title. */
  name?: string;
  /** Profile URLs (GitHub, X, LinkedIn, …) that identify the organization. */
  sameAs: string[];
  telephone?: string;
  /** Defaults to the site origin. */
  url?: string;
}

/**
 * `seo.software`: the product the site documents, emitted on the homepage as
 * a `SoftwareApplication` node — the identity type agents use to tell what a
 * docs site is about.
 */
export interface SoftwareIdentity {
  applicationCategory: string;
  /** Defaults to the site description. */
  description?: string;
  /** License URL or SPDX identifier. */
  license?: string;
  /** Defaults to the site title. */
  name?: string;
  operatingSystem?: string;
  /** Emitted as an `Offer` when set; `0` marks the software free. */
  price?: number | string;
  priceCurrency: string;
  /** Package registry, repository, and profile URLs for the product. */
  sameAs: string[];
}

/** The site-level identity nodes, from `seo.organization`/`seo.software`. */
export interface StructuredDataIdentity {
  organization?: OrganizationIdentity;
  software?: SoftwareIdentity;
}

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
  /**
   * Site identity (`seo.organization`, `seo.software`). Both nodes need an
   * absolute `@id`, so they are emitted only when `siteUrl` is set — like the
   * WebSite node.
   */
  identity?: StructuredDataIdentity | null;
}

/** schema.org `@type` for each content type; defaults to TechArticle. */
const ARTICLE_TYPES = {
  blog: "BlogPosting",
  changelog: "TechArticle",
} as const;

/**
 * `hasOwn` (not a bare index) so a content type named like an
 * `Object.prototype` member can't resolve a function up the prototype chain.
 */
const isArticleType = (value: string): value is keyof typeof ARTICLE_TYPES =>
  Object.hasOwn(ARTICLE_TYPES, value);

/** A value a schema.org node property can hold. */
type JsonLdValue = string | number | JsonLdValue[] | JsonLdNode;

/** A schema.org node: JSON-LD keys to concrete JSON values. */
export interface JsonLdNode {
  [key: string]: JsonLdValue;
}

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

/** Copy the defined string entries of `source` onto a fresh node. */
const definedStrings = (
  source: Record<string, string | undefined>
): JsonLdNode => {
  const node: JsonLdNode = {};
  for (const [key, value] of Object.entries(source)) {
    if (value) {
      node[key] = value;
    }
  }
  return node;
};

/**
 * The `Organization` node: name and URL (defaulting to the site's), logo, the
 * `sameAs` profiles, a `ContactPoint` when there is a way to make contact,
 * and a `PostalAddress` when any part of one is given — the fields agents
 * check to verify a business before recommending it.
 */
const organizationNode = (
  organization: OrganizationIdentity,
  context: {
    absolutize: (path: string) => string;
    id: string;
    rootUrl: string;
    siteName: string;
  }
): JsonLdNode => {
  const node: JsonLdNode = {
    "@id": context.id,
    "@type": "Organization",
    name: organization.name ?? context.siteName,
    url: organization.url ?? context.rootUrl,
  };
  if (organization.logo) {
    node.logo = context.absolutize(organization.logo);
  }
  if (organization.email) {
    node.email = organization.email;
  }
  if (organization.telephone) {
    node.telephone = organization.telephone;
  }
  if (organization.email || organization.telephone) {
    node.contactPoint = {
      "@type": "ContactPoint",
      contactType: organization.contactType,
      ...definedStrings({
        email: organization.email,
        telephone: organization.telephone,
      }),
    };
  }
  const address = organization.address
    ? definedStrings({ ...organization.address })
    : {};
  if (Object.keys(address).length > 0) {
    node.address = { "@type": "PostalAddress", ...address };
  }
  if (organization.sameAs.length > 0) {
    node.sameAs = organization.sameAs;
  }
  return node;
};

/**
 * The homepage `SoftwareApplication` node: the product's identity (name,
 * description, category), an `Offer` when a price is declared (`0` for free
 * software), license, registry/repository profiles, and the organization as
 * its publisher when one is configured.
 */
const softwareNode = (
  software: SoftwareIdentity,
  context: {
    description?: string;
    id: string;
    organizationId: string | null;
    rootUrl: string;
    siteName: string;
  }
): JsonLdNode => {
  const node: JsonLdNode = {
    "@id": context.id,
    "@type": "SoftwareApplication",
    applicationCategory: software.applicationCategory,
    name: software.name ?? context.siteName,
    url: context.rootUrl,
  };
  const description = software.description ?? context.description;
  if (description) {
    node.description = description;
  }
  if (software.operatingSystem) {
    node.operatingSystem = software.operatingSystem;
  }
  if (software.price !== undefined) {
    node.offers = {
      "@type": "Offer",
      price: String(software.price),
      priceCurrency: software.priceCurrency,
    };
  }
  if (software.license) {
    node.license = software.license;
  }
  if (software.sameAs.length > 0) {
    node.sameAs = software.sameAs;
  }
  if (context.organizationId) {
    node.publisher = { "@id": context.organizationId };
  }
  return node;
};

/** The page as an article node (`BlogPosting`/`TechArticle`). */
const articleNode = (
  input: StructuredDataInput,
  context: {
    base: string | null;
    organizationId: string | null;
    pageUrl: string;
  }
): JsonLdNode => {
  const pageType = input.pageType ?? "";
  const node: JsonLdNode = {
    "@id": `${context.pageUrl}#page`,
    "@type": isArticleType(pageType) ? ARTICLE_TYPES[pageType] : "TechArticle",
    headline: input.title,
    inLanguage: input.locale || "en",
    name: input.title,
    url: context.pageUrl,
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
  if (context.base) {
    node.isPartOf = { "@id": `${context.base}#website` };
  }
  if (context.organizationId) {
    node.publisher = { "@id": context.organizationId };
  }
  return node;
};

/**
 * The breadcrumb trail, or null when it is too short to be one. Google
 * requires `item` on every ListItem except the last; sidebar groups without
 * an index page produce route-less crumbs, so those are dropped (positions
 * renumbered) rather than emitted as invalid link-less items.
 */
const breadcrumbNode = (
  breadcrumbs: Crumb[],
  base: string | null,
  deployBase: string
): JsonLdNode | null => {
  const linked = breadcrumbs.filter(
    (crumb): crumb is Required<Crumb> => typeof crumb.route === "string"
  );
  if (linked.length <= 1) {
    return null;
  }
  return {
    "@type": "BreadcrumbList",
    itemListElement: linked.map((crumb, index) => ({
      "@type": "ListItem",
      item: absolute(base, withBasePath(deployBase, crumb.route)),
      name: crumb.label,
      position: index + 1,
    })),
  };
};

/**
 * Build a schema.org JSON-LD `@graph` for a page: site identity (the WebSite,
 * plus the configured Organization everywhere and the SoftwareApplication on
 * the homepage), the page as an article, and its breadcrumb trail. Returns
 * null when there is nothing useful to emit (e.g. the homepage without a
 * configured site). URLs are absolute when `siteUrl` is set, otherwise
 * route-relative.
 */
export const buildStructuredData = (
  input: StructuredDataInput
): JsonLdNode | null => {
  const base = input.siteUrl ? trimSlash(input.siteUrl) : null;
  // Routes carry `basePath`; a `deployment.base` subdirectory is layered on top
  // so JSON-LD URLs match the served location.
  const deployBase = normalizeBasePath(input.base);
  const pageUrl = absolute(base, withBasePath(deployBase, input.route));
  const rootUrl = absolute(base, deployBase);
  const graph: JsonLdNode[] = [];

  // Identity nodes carry absolute `@id`s, so they exist only with a site —
  // the same rule as the WebSite node they attach to.
  const organization = base ? input.identity?.organization : undefined;
  const software = base ? input.identity?.software : undefined;
  const organizationId = organization ? `${base}#organization` : null;

  if (base) {
    const website: JsonLdNode = {
      "@id": `${base}#website`,
      "@type": "WebSite",
      name: input.siteName,
      url: rootUrl,
    };
    if (organizationId) {
      website.publisher = { "@id": organizationId };
    }
    graph.push(website);
  }
  if (organization && organizationId) {
    graph.push(
      organizationNode(organization, {
        // A root-relative logo lives under the deployment base like any
        // other site asset; an absolute URL passes through.
        absolutize: (path) =>
          path.startsWith("/")
            ? absolute(base, withBasePath(deployBase, path))
            : path,
        id: organizationId,
        rootUrl,
        siteName: input.siteName,
      })
    );
  }

  // The homepage is described by the WebSite node (and the product, when one
  // is configured); deeper pages get an article node plus a breadcrumb trail.
  if (input.route === "/") {
    if (software && base) {
      graph.push(
        softwareNode(software, {
          description: input.description,
          id: `${base}#software`,
          organizationId,
          rootUrl,
          siteName: input.siteName,
        })
      );
    }
  } else {
    graph.push(articleNode(input, { base, organizationId, pageUrl }));
    const breadcrumbs = breadcrumbNode(input.breadcrumbs, base, deployBase);
    if (breadcrumbs) {
      graph.push(breadcrumbs);
    }
  }

  if (graph.length === 0) {
    return null;
  }
  return { "@context": "https://schema.org", "@graph": graph };
};
