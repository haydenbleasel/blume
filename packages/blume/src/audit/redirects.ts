import type { RedirectResolution } from "./types.ts";
import { normalizePath } from "./url.ts";

interface ConfiguredRedirect {
  from: string;
  to: string;
  status: number;
}

/**
 * Follow every configured redirect through to its destination, classifying what
 * it lands on.
 *
 * - `loop`   — the chain revisits a hop it has already been to. Never resolves.
 * - `broken` — the chain ends somewhere that isn't a built page.
 * - `chain`  — it resolves, but through at least one intermediate redirect.
 * - `ok`     — one hop, straight to a real page.
 *
 * An external destination (`https://…`) is always `ok`: it's outside the site,
 * so there's no local page to check it against.
 */
export const resolveRedirects = (
  redirects: readonly ConfiguredRedirect[],
  pageUrls: ReadonlySet<string>
): RedirectResolution[] => {
  const byFrom = new Map<string, ConfiguredRedirect>();
  for (const redirect of redirects) {
    byFrom.set(normalizePath(redirect.from), redirect);
  }

  return redirects.map((redirect) => {
    const from = normalizePath(redirect.from);
    const chain: string[] = [from];
    const seen = new Set<string>([from]);
    let current = redirect.to;

    for (;;) {
      // An external hop ends the walk — we can't follow it locally.
      if (/^https?:\/\//iu.test(current)) {
        chain.push(current);
        break;
      }
      const next = normalizePath(current);
      if (seen.has(next)) {
        chain.push(next);
        return {
          ...redirect,
          chain,
          outcome: "loop" as const,
        };
      }
      chain.push(next);
      seen.add(next);
      const hop = byFrom.get(next);
      if (!hop) {
        break;
      }
      current = hop.to;
    }

    const destination = chain.at(-1) ?? from;
    const external = /^https?:\/\//iu.test(destination);
    if (!(external || pageUrls.has(destination))) {
      return { ...redirect, chain, outcome: "broken" as const };
    }
    // `chain` is [from, …hops, destination]; more than two entries means at
    // least one intermediate redirect.
    return {
      ...redirect,
      chain,
      outcome: chain.length > 2 ? ("chain" as const) : ("ok" as const),
    };
  });
};
