import { stripUnknownPageMeta } from "../shared.ts";

/**
 * Normalize Fumadocs page frontmatter for Blume. Fumadocs' core fields
 * (`title`, `description`, `icon`) already validate against Blume's page schema
 * and pass through untouched; Fumadocs-only keys with no equivalent — most
 * notably `full` (full-width, no-TOC layout) — are dropped by the strict-schema
 * strip and reported so the author can re-apply them by hand.
 */
export const normalizeFumadocsPageMeta = (
  value: unknown
): { data: Record<string, unknown>; removed: string[] } => {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  return stripUnknownPageMeta(data);
};
