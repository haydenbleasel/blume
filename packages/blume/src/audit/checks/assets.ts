import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import type { CheckId } from "../catalog.ts";
import { pageSite } from "../locate.ts";
import type {
  AuditContext,
  CheckModule,
  PageSnapshot,
  SnapshotAsset,
} from "../types.ts";
import { resolveHref, siteOrigin } from "../url.ts";

const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} kB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Resolve a subresource reference to its file in the build, reporting a missing
 * file or an insecure (`http://`) reference. Returns the file's size when it
 * resolves to something real and local.
 */
const resolveAsset = (
  context: AuditContext,
  page: PageSnapshot,
  asset: SnapshotAsset,
  missingId: CheckId,
  kind: string,
  found: Diagnostic[]
): number | null => {
  if (asset.src.startsWith("http://")) {
    found.push(
      finding(
        "BLUME_AUDIT_MIXED_CONTENT",
        pageSite(context, page),
        `Page loads ${kind} over plain HTTP: ${asset.src}`
      )
    );
    return null;
  }
  if (asset.src.startsWith("data:")) {
    return null;
  }

  const origin = siteOrigin(context.project.config.deployment.site);
  const resolved = resolveHref(page.url, asset.src, origin);
  // A subresource on another origin (a CDN, an analytics script) is outside the
  // build; we can't check whether it exists without the network.
  if (resolved.kind === "external" || resolved.kind === "ignored") {
    return null;
  }

  const bytes = context.files.get(resolved.path);
  if (bytes === undefined) {
    found.push(
      finding(
        missingId,
        pageSite(context, page),
        `Page references ${asset.src}, which is not in the build.`
      )
    );
    return null;
  }
  return bytes;
};

/**
 * Images, scripts, and stylesheets: do they exist, are they secure, are they
 * too heavy, and (for images) are they accessible and layout-stable.
 *
 * Ahrefs devotes ~18 rows to this across its Images, JavaScript, and CSS
 * sections — "JS redirects", "page has redirected CSS", "HTTPS page links to
 * HTTP JavaScript", and both an asset-scoped and a page-scoped copy of each.
 * Vite emits content-hashed, existent, non-redirecting bundles, so nearly all of
 * that is unfireable; what's left is this.
 */
export const assetChecks: CheckModule = {
  category: "assets",
  run(context) {
    const found: Diagnostic[] = [];
    const { maxAssetBytes } = context.thresholds;

    const weigh = (
      page: PageSnapshot,
      asset: SnapshotAsset,
      bytes: number | null,
      kind: string
    ): void => {
      if (bytes !== null && bytes > maxAssetBytes) {
        found.push(
          finding(
            "BLUME_AUDIT_ASSET_TOO_LARGE",
            pageSite(context, page),
            `${kind} ${asset.src} is ${formatBytes(bytes)} (over ${formatBytes(maxAssetBytes)}).`
          )
        );
      }
    };

    for (const page of context.pages) {
      for (const image of page.images) {
        const bytes = resolveAsset(
          context,
          page,
          image,
          "BLUME_AUDIT_IMAGE_BROKEN",
          "an image",
          found
        );
        weigh(page, image, bytes, "Image");

        // `alt=""` is a deliberate "this image is decorative" and is correct.
        // A missing `alt` attribute is the finding.
        if (image.alt === null) {
          found.push(
            finding(
              "BLUME_AUDIT_IMAGE_ALT_MISSING",
              pageSite(context, page),
              `Image ${image.src} has no alt attribute.`
            )
          );
        }

        if (!(image.width && image.height)) {
          found.push(
            finding(
              "BLUME_AUDIT_IMAGE_MISSING_DIMENSIONS",
              pageSite(context, page),
              `Image ${image.src} has no width/height, so it will shift the layout as it loads.`
            )
          );
        }
      }

      for (const script of page.scripts) {
        weigh(
          page,
          script,
          resolveAsset(
            context,
            page,
            script,
            "BLUME_AUDIT_SUBRESOURCE_MISSING",
            "a script",
            found
          ),
          "Script"
        );
      }

      for (const style of page.styles) {
        weigh(
          page,
          style,
          resolveAsset(
            context,
            page,
            style,
            "BLUME_AUDIT_SUBRESOURCE_MISSING",
            "a stylesheet",
            found
          ),
          "Stylesheet"
        );
      }
    }

    return found;
  },
  tier: "static",
};
