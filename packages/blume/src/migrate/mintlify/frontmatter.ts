import { z } from "zod";

import { pageMetaSchema } from "../../core/schema.ts";

/**
 * One-time translation of Mintlify page frontmatter into Blume's shape. This
 * runs at migration time only — Blume's runtime page schema stays
 * Mintlify-free and strict. `sidebarTitle`/`icon`/`tag`/`hidden` fold into
 * `sidebar`, `hidden` implies `noindex`, `canonical`/`og:image` move under
 * `seo`, and OpenAPI/AsyncAPI pages become `type: "api"`.
 */

const mintlifySidebarMetaSchema = z
  .object({
    badge: z.string().optional(),
    hidden: z.boolean().optional(),
    icon: z.string().optional(),
    label: z.string().optional(),
    order: z.number().optional(),
  })
  .passthrough();

const mintlifyPageMetaInputSchema = z
  .object({
    api: z.unknown().optional(),
    asyncapi: z.string().optional(),
    canonical: z.string().optional(),
    hidden: z.boolean().optional(),
    icon: z.string().optional(),
    noindex: z.boolean().optional(),
    "og:image": z.string().optional(),
    openapi: z.string().optional(),
    sidebar: mintlifySidebarMetaSchema.optional(),
    sidebarTitle: z.string().optional(),
    tag: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

type MintlifyPageMetaInput = z.infer<typeof mintlifyPageMetaInputSchema>;

const normalizedMintlifySidebar = (meta: MintlifyPageMetaInput) => ({
  ...meta.sidebar,
  ...(meta.sidebarTitle !== undefined && meta.sidebar?.label === undefined
    ? { label: meta.sidebarTitle }
    : {}),
  ...(meta.icon !== undefined && meta.sidebar?.icon === undefined
    ? { icon: meta.icon }
    : {}),
  ...(meta.tag !== undefined && meta.sidebar?.badge === undefined
    ? { badge: meta.tag }
    : {}),
  ...(meta.hidden === true && meta.sidebar?.hidden === undefined
    ? { hidden: true }
    : {}),
});

const mintlifyPageType = (meta: MintlifyPageMetaInput): string | undefined =>
  meta.type ??
  (meta.openapi !== undefined ||
  meta.asyncapi !== undefined ||
  meta.api !== undefined
    ? "api"
    : undefined);

const mintlifyNoindex = (meta: MintlifyPageMetaInput): boolean | undefined =>
  meta.hidden === true && meta.noindex === undefined ? true : meta.noindex;

/** Top-level Mintlify keys folded elsewhere — removed from the output. */
const CONSUMED_KEYS = new Set([
  "canonical",
  "hidden",
  "icon",
  "og:image",
  "sidebarTitle",
  "tag",
]);

/** Map Mintlify page frontmatter onto Blume's frontmatter shape. */
export const normalizeMintlifyPageMeta = (
  value: unknown
): Record<string, unknown> => {
  const parsed = mintlifyPageMetaInputSchema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null) {
    return (value ?? {}) as Record<string, unknown>;
  }

  const meta = parsed.data;
  const source = value as Record<string, unknown>;
  const data: Record<string, unknown> = { ...source };

  const sidebar = normalizedMintlifySidebar(meta);
  if (Object.keys(sidebar).length > 0) {
    data.sidebar = sidebar;
  }

  const seo: Record<string, unknown> = {
    ...(typeof source.seo === "object" && source.seo !== null
      ? (source.seo as Record<string, unknown>)
      : {}),
  };
  if (meta.canonical !== undefined && seo.canonical === undefined) {
    seo.canonical = meta.canonical;
  }
  if (meta["og:image"] !== undefined && seo.image === undefined) {
    seo.image = meta["og:image"];
  }
  if (Object.keys(seo).length > 0) {
    data.seo = seo;
  }

  const noindex = mintlifyNoindex(meta);
  if (noindex !== undefined) {
    data.noindex = noindex;
  }
  const type = mintlifyPageType(meta);
  if (type !== undefined) {
    data.type = type;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(data)) {
    if (!CONSUMED_KEYS.has(key)) {
      cleaned[key] = raw;
    }
  }
  return cleaned;
};

/**
 * Remove frontmatter keys Blume's strict page schema would reject (e.g. stray
 * `og:*`/`twitter:*` metatags) so the migrated page validates, reporting what
 * was dropped.
 */
export const stripUnknownPageMeta = (
  data: Record<string, unknown>
): { data: Record<string, unknown>; removed: string[] } => {
  const result = pageMetaSchema.safeParse(data);
  if (result.success) {
    return { data, removed: [] };
  }

  const removed = new Set<string>();
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys" && issue.path.length === 0) {
      for (const key of issue.keys) {
        removed.add(key);
      }
    }
  }
  if (removed.size === 0) {
    // The frontmatter is invalid for a reason other than stray keys; leave it
    // for Blume to report when the user runs `blume dev`.
    return { data, removed: [] };
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!removed.has(key)) {
      next[key] = value;
    }
  }
  return { data: next, removed: [...removed] };
};
