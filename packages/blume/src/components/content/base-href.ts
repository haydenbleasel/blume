import data from "blume:data";

import {
  normalizeBasePath,
  withAuthoredBasePath,
} from "../../core/base-path.ts";
import { routeSetFor, servesRoute } from "../../core/locale-links.ts";

/**
 * Rebase a component-emitted `href` the way `markdown/base-links.ts` rebases
 * `[x](/guide)`: a root-relative internal page link gains the composed
 * `deployment.base` + `basePath` prefix, and a public asset (`/spec.pdf`, with
 * no page served there) the deployment base alone, so authors write component
 * links (`<Card href="/guide">`) under the same "as if mounted at root"
 * contract as markdown links (see `withAuthoredBasePath`). Idempotent per
 * layer (a hand-written `/docs/x` isn't double-prefixed) and inert for
 * external URLs, fragments, and relative paths.
 */
export const contentHref = (href: string): string =>
  withAuthoredBasePath(
    normalizeBasePath(import.meta.env.BASE_URL),
    data.config.basePath,
    href,
    (route) => servesRoute(routeSetFor(data.routes), route)
  );
