import type { Crumb } from "../components/layout/nav-utils.ts";
import {
  mountBasePath,
  normalizeBasePath,
  withBasePath,
} from "../core/base-path.ts";

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
 * as an `Organization` node the WebSite and page nodes cite as publisher.
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

/**
 * `seo.jsonLd`: entities the docs share with a site they live inside
 * (`example.com/docs`), referenced by `@id` instead of defined again.
 */
export interface JsonLdEntities {
  /** Credited on pages without their own `authors`. */
  author?: { "@id": string };
  /** Cited as every page's publisher in place of the Organization's id. */
  publisher?: { "@id": string };
  /** The Organization's `@id`, defined here or elsewhere. */
  organizationId?: string;
  /** Emit the WebSite node. Defaults to true unless `websiteId` is set. */
  website?: boolean;
  /** The WebSite's `@id`, which every page names as `isPartOf`. */
  websiteId?: string;
}

/** A front matter `authors` entry: a name, or a name with a profile URL. */
export type AuthorInput = string | { name: string; url?: string };

/** Inputs for a page's JSON-LD, all known at render time in RootLayout. */
export interface StructuredDataInput {
  jsonLd?: JsonLdEntities;
  /**
   * The page's `og:image`, emitted as the page node's `image`. Absolute when
   * `siteUrl` is set, otherwise root-relative like every other URL here.
   */
  image?: string | null;
  /** The page's own byline, which wins over `jsonLd.author`. */
  authors?: AuthorInput | AuthorInput[];
  siteName: string;
  /** Absolute site origin, or null when `deployment.site` is unset. */
  siteUrl: string | null;
  title: string;
  description?: string;
  /** Page route, e.g. `/blog/post`. */
  route: string;
  /**
   * The route of this page's homepage: the navigation tree root
   * (`navigation.root` — `/fr` for a locale, `/docs` under a `basePath`,
   * `/v1.0` in an archived version). Defaults to `/`.
   */
  homeRoute?: string;
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
    /** The site's name and root, or null when the id names an outside entity. */
    defaults: { name: string; url: string } | null;
  }
): JsonLdNode => {
  const node: JsonLdNode = {
    "@id": context.id,
    "@type": "Organization",
    ...definedStrings({
      name: organization.name ?? context.defaults?.name,
      url: organization.url ?? context.defaults?.url,
    }),
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

/** The page's schema.org `@type`: a `WebPage` for a homepage, else an article. */
const pageSchemaType = (input: StructuredDataInput, home: boolean): string => {
  if (home) {
    return "WebPage";
  }
  const pageType = input.pageType ?? "";
  return isArticleType(pageType) ? ARTICLE_TYPES[pageType] : "TechArticle";
};

/** An `authors` entry is a bare name or a name with a profile URL. */
const isBareName = (author: AuthorInput): author is string =>
  typeof author === "string";

/** `Person` nodes for a page's front matter `authors`. */
const authorNodes = (authors: AuthorInput | AuthorInput[]): JsonLdNode[] =>
  [authors].flat().map((author): JsonLdNode => ({
    "@type": "Person",
    ...(isBareName(author)
      ? { name: author }
      : definedStrings({ name: author.name, url: author.url })),
  }));

/**
 * The page's own node: a homepage is a `WebPage` (it isn't an article, but it
 * still needs a machine-readable date, or search engines take whatever other
 * date the page shows), and every other page an article (`BlogPosting`/
 * `TechArticle`) with a `headline`. Both carry the language, description,
 * dates, the WebSite they belong to, and the publisher.
 */
const pageNode = (
  input: StructuredDataInput,
  context: {
    base: string | null;
    home: boolean;
    organizationId: string | null;
    pageUrl: string;
  }
): JsonLdNode => {
  const node: JsonLdNode = {
    "@id": `${context.pageUrl}#page`,
    "@type": pageSchemaType(input, context.home),
    inLanguage: input.locale || "en",
    name: input.title,
    url: context.pageUrl,
  };
  if (!context.home) {
    node.headline = input.title;
  }
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
  // A shared id is already absolute, so it holds without a site URL too.
  const websiteId =
    input.jsonLd?.websiteId ??
    (context.base ? `${context.base}#website` : null);
  if (websiteId) {
    node.isPartOf = { "@id": websiteId };
  }
  const publisher = input.jsonLd?.publisher?.["@id"] ?? context.organizationId;
  if (publisher) {
    node.publisher = { "@id": publisher };
  }
  const authors = input.authors ? authorNodes(input.authors) : [];
  if (authors.length > 0) {
    node.author = authors;
  } else if (input.jsonLd?.author) {
    node.author = input.jsonLd.author;
  }
  if (input.image) {
    node.image = input.image;
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
      item: absolute(base, mountBasePath(deployBase, crumb.route)),
      name: crumb.label,
      position: index + 1,
    })),
  };
};

/**
 * The site's `WebSite` node, which needs the site URL. A shared `websiteId`
 * names one the parent site defines, so the docs leave it out unless
 * `jsonLd.website` asks for it — their own name and root would contradict it.
 */
const addWebsiteNode = (
  graph: JsonLdNode[],
  input: StructuredDataInput,
  base: string | null,
  rootUrl: string,
  organizationId: string | null
): void => {
  if (base && (input.jsonLd?.website ?? !input.jsonLd?.websiteId)) {
    const website: JsonLdNode = {
      "@id": input.jsonLd?.websiteId ?? `${base}#website`,
      "@type": "WebSite",
      name: input.siteName,
      url: rootUrl,
    };
    if (organizationId) {
      website.publisher = { "@id": organizationId };
    }
    graph.push(website);
  }
};

/**
 * Build a schema.org JSON-LD `@graph` for a page: site identity (the WebSite,
 * plus the configured Organization everywhere and the SoftwareApplication on
 * the homepage), the page itself (a WebPage on the homepage, an article
 * elsewhere), and an article's breadcrumb trail. URLs are absolute when
 * `siteUrl` is set, otherwise route-relative.
 */
export const buildStructuredData = (input: StructuredDataInput): JsonLdNode => {
  const base = input.siteUrl ? trimSlash(input.siteUrl) : null;
  // Routes carry `basePath`; a `deployment.base` subdirectory is layered on top
  // so JSON-LD URLs match the served location.
  const deployBase = normalizeBasePath(input.base);
  const pageUrl = absolute(base, mountBasePath(deployBase, input.route));
  const rootUrl = absolute(base, deployBase);
  const graph: JsonLdNode[] = [];

  // Identity nodes carry absolute `@id`s, so they exist only with a site —
  // the same rule as the WebSite node they attach to.
  const organization = base ? input.identity?.organization : undefined;
  const software = base ? input.identity?.software : undefined;
  const organizationId =
    input.jsonLd?.organizationId ??
    (organization ? `${base}#organization` : null);

  addWebsiteNode(graph, input, base, rootUrl, organizationId);
  if (organization && organizationId) {
    graph.push(
      organizationNode(organization, {
        // A root-relative logo lives under the deployment base like any
        // other site asset; an absolute URL passes through.
        absolutize: (path) =>
          path.startsWith("/")
            ? absolute(base, withBasePath(deployBase, path))
            : path,
        // A shared id names an organization defined elsewhere, which the
        // docs' title and root would contradict; only configured fields go in.
        defaults: input.jsonLd?.organizationId
          ? null
          : { name: input.siteName, url: rootUrl },
        id: organizationId,
      })
    );
  }

  // The homepage is a WebPage, next to the product when one is configured;
  // deeper pages are articles with a breadcrumb trail.
  const home = input.route === (input.homeRoute ?? "/");
  graph.push(pageNode(input, { base, home, organizationId, pageUrl }));
  if (home) {
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
    const breadcrumbs = breadcrumbNode(input.breadcrumbs, base, deployBase);
    if (breadcrumbs) {
      graph.push(breadcrumbs);
    }
  }

  return { "@context": "https://schema.org", "@graph": graph };
};
