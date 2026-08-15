import { localizeRoute } from "./i18n.ts";
import type {
  ArchivedVersionConfig,
  ResolvedConfig,
  ResolvedI18nConfig,
  ResolvedVersionsConfig,
} from "./schema.ts";
import type { Diagnostic, PageRecord } from "./types.ts";

/**
 * Version logic, centralized. Every seam that needs to reason about docs
 * versions (content discovery, navigation, manifest, runtime generation, the
 * catch-all) goes through these helpers so the routing rules live in exactly
 * one place — the same contract `./i18n.ts` holds for locales.
 *
 * The current version is the empty string `""`: the latest docs live at the
 * content root with unprefixed URLs, and only archived snapshots have a
 * directory and a URL segment.
 */

/**
 * Top-level folders that look like a version (`v1`, `V2.0`) — used by the
 * unconfigured-snapshot diagnostic and by `blume version` to keep such folders
 * out of new snapshots.
 */
export const VERSION_SHAPED = /^v\d/iu;

/** True when the project opts into versioning. */
export const versionsEnabled = (
  config: ResolvedConfig
): config is ResolvedConfig & { versions: ResolvedVersionsConfig } =>
  config.versions !== undefined;

/** All archived version ids, in configured (switcher) order. */
export const archivedIds = (versions: ResolvedVersionsConfig): string[] =>
  versions.archived.map((version) => version.id);

/** Switcher label for a version: the current label for `""`, else per config. */
export const versionLabel = (
  id: string,
  versions: ResolvedVersionsConfig
): string => {
  if (id === "") {
    return versions.current.label;
  }
  const archived = versions.archived.find((version) => version.id === id);
  return archived?.label ?? id;
};

/** The archived version config for an id (`undefined` for current/unknown). */
export const archivedVersion = (
  id: string,
  versions: ResolvedVersionsConfig
): ArchivedVersionConfig | undefined =>
  versions.archived.find((version) => version.id === id);

/**
 * Detect a leading archived-version directory in a path's segments. The
 * current version lives at the content root, so only archived ids are matched
 * as a leading segment. Returns the resolved version (`""` for current) and
 * the remaining (version-stripped) segments. Runs BEFORE locale detection —
 * the snapshot directory is outermost on disk, so the locale parser must see
 * a version-stripped path.
 */
export const detectVersion = (
  parts: string[],
  versions: ResolvedVersionsConfig
): { version: string; rest: string[] } => {
  const [first] = parts;
  if (first && versions.archived.some((version) => version.id === first)) {
    return { rest: parts.slice(1), version: first };
  }
  return { rest: parts, version: "" };
};

/**
 * {@link detectVersion} over a slash-joined source ref (`v1.0/fr/x.mdx`):
 * returns the version and the version-stripped ref for the locale parser and
 * route mapping to consume.
 */
export const detectVersionRef = (
  ref: string,
  versions: ResolvedVersionsConfig
): { version: string; rest: string } => {
  const { version, rest } = detectVersion(ref.split("/"), versions);
  return { rest: rest.join("/"), version };
};

/**
 * Prefix a version-agnostic logical route with its version: `/guides/x`
 * becomes `/v1.0/guides/x`, `/` becomes `/v1.0`. The current version (`""`)
 * is the identity.
 */
export const versionizeRoute = (
  logicalRoute: string,
  version: string
): string => {
  if (!version) {
    return logicalRoute;
  }
  return logicalRoute === "/" ? `/${version}` : `/${version}${logicalRoute}`;
};

/**
 * The localized root route of a version: `/`, `/fr`, `/v1.0`, or `/fr/v1.0`.
 * The locale prefix stays outermost, matching how page routes compose
 * (`localizeRoute(versionizeRoute(...))`).
 */
export const versionRoot = (
  version: string,
  locale?: string,
  i18n?: ResolvedI18nConfig
): string => {
  const logical = versionizeRoute("/", version);
  if (i18n && locale !== undefined) {
    return localizeRoute(logical, locale, i18n);
  }
  return logical;
};

/**
 * Warn about top-level content folders shaped like a version (`v1`, `v2.0`)
 * that aren't declared in `versions.archived`. Without this they're silently
 * treated as current-version content under a `/<folder>/…` route — usually a
 * snapshot that wasn't registered in config.
 */
export const versionsDiagnostics = (
  pages: PageRecord[],
  versions: ResolvedVersionsConfig
): Diagnostic[] => {
  // Exact-id comparison, matching `detectVersion`: a folder that differs from
  // a configured id only by case (`V1.0/` vs `v1.0`) is NOT routed as that
  // snapshot, so it must still warn. `VERSION_SHAPED` is case-insensitive on
  // its own.
  const configured = new Set(versions.archived.map((version) => version.id));
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const page of pages) {
    // The version-looking folder is the first segment of the source-local ref
    // (e.g. `v1.0/guide.md`), not the namespaced id (`filesystem:v1.0/guide.md`).
    const [first] = page.source.ref.split("/");
    if (
      first &&
      !seen.has(first) &&
      VERSION_SHAPED.test(first) &&
      !configured.has(first)
    ) {
      seen.add(first);
      diagnostics.push({
        code: "BLUME_VERSIONS_UNCONFIGURED_VERSION",
        message: `Folder "${first}/" looks like a version, but "${first}" is not in versions.archived — its pages are treated as current-version content at /${first}/….`,
        severity: "warning",
        suggestion: `Add { id: "${first}" } to versions.archived, or rename the folder if it isn't a snapshot.`,
      });
    }
  }
  return diagnostics;
};
