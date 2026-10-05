/**
 * Pattern redirects: a `from` that covers many paths, written the way
 * Mintlify and `vercel.json` write them.
 *
 * - `:name` matches one whole segment: `/blog/:slug` → `/articles/:slug`.
 * - `:name*` as the last segment matches the rest of the path, any number of
 *   segments: `/beta/:slug*` → `/v2/:slug*` sends `/beta/a/b` to `/v2/a/b`
 *   and `/beta` itself to `/v2`. A last segment of `*` does the same.
 * - `*` ending a segment matches the rest of the path from there:
 *   `/articles/concepts-*` → `/overview`, or `/old/article-*` →
 *   `/new/article-*` to carry what it matched (`/new/article-:splat`, as
 *   `_redirects` spells it, reads the same capture).
 *
 * `to` reads a capture as a whole segment (`/:name`, `/:name*`, `/*`) or, for
 * `*`, wherever it stands. Hosts disagree on the rest of the syntax, so each
 * gets its own translation from {@link expandRedirect}: `_redirects` splats,
 * `vercel.json` sources, and the regular expressions Vercel's routing config,
 * the Node and Cloudflare wrappers, and the dev server match with. A capture
 * that may be empty is expanded into two rules first, so `/beta` lands on
 * `/v2` rather than `/v2/` on every host.
 */

import { normalizePath } from "./base-path.ts";

/** The name `*` captures under, which `_redirects` reads as `:splat`. */
export const SPLAT = "splat";

/** A piece of a parsed `from`, or of a rule it expands to. */
type Part =
  | { kind: "text"; text: string }
  /** `:name`: one whole segment. */
  | { kind: "param"; name: string }
  /** `/:name*` or `/*` ending the path: zero or more segments. */
  | { kind: "rest"; name: string }
  /** A rest in an expanded rule: one or more characters after its `/`. */
  | { kind: "tail"; name: string }
  /** `*` ending a segment: any characters, none included. */
  | { kind: "splat" };

/** A piece of an expanded rule, where a rest has become a tail. */
type RulePart = Exclude<Part, { kind: "rest" }>;

/** A redirect's two ends, as configured or based. */
interface RedirectEnds {
  from: string;
  status: number;
  to: string;
}

/** One rule a redirect expands to. */
export interface RedirectRule {
  parts: RulePart[];
  status: number;
  to: string;
}

const PARAM = /^:(?<name>[A-Za-z_]\w*)(?<rest>\*)?$/u;
const PARAM_START = /^:[A-Za-z_]/u;

/**
 * A capture read in `to`: a whole segment (`/:name`, `/:name*`, `/*`), which
 * an empty value drops along with its slash, or a `*` anywhere.
 */
const REFERENCE = /\/(?::(?<name>[A-Za-z_]\w*)\*?|\*)(?=[/?#]|$)|\*/gu;

/** Parsed pieces, or why they can't be parsed. */
type Parsed = { parts: Part[] } | { error: string };

const text = (value: string): Part[] =>
  value ? [{ kind: "text", text: value }] : [];

/** The pieces of one `from` segment after the ones before it. */
const segmentParts = (
  segment: string,
  last: boolean,
  names: Set<string>
): Parsed => {
  const param = PARAM.exec(segment)?.groups;
  if (param?.name) {
    const { name } = param;
    if (name === SPLAT) {
      return {
        error:
          "`:splat` is the name `*` captures under; name the segment something else.",
      };
    }
    if (names.has(name)) {
      return {
        error: `\`:${name}\` appears twice; give each segment its own name.`,
      };
    }
    names.add(name);
    if (!param.rest) {
      return {
        parts: [
          { kind: "text", text: "/" },
          { kind: "param", name },
        ],
      };
    }
    return last
      ? { parts: [{ kind: "rest", name }] }
      : {
          error: `\`:${name}*\` matches the rest of the path, so it must be the last segment.`,
        };
  }
  if (PARAM_START.test(segment)) {
    return {
      error: `\`${segment}\` isn't a whole-segment \`:param\`; write \`/:name\` or \`/:name*\`.`,
    };
  }
  const star = segment.indexOf("*");
  if (star === -1) {
    return { parts: text(`/${segment}`) };
  }
  if (!last || star !== segment.length - 1) {
    return {
      error: "`*` matches the rest of the path, so it can only end it.",
    };
  }
  names.add(SPLAT);
  return segment === "*"
    ? { parts: [{ kind: "rest", name: SPLAT }] }
    : { parts: [...text(`/${segment.slice(0, -1)}`), { kind: "splat" }] };
};

/** Merge neighboring text pieces, so each format sees one run of literal path. */
const joinText = <Piece extends Part>(parts: readonly Piece[]): Piece[] => {
  const joined: Piece[] = [];
  for (const part of parts) {
    const previous = joined.at(-1);
    if (part.kind === "text" && previous?.kind === "text") {
      // A fresh piece: the one before may be shared with another rule.
      joined[joined.length - 1] = {
        ...previous,
        text: previous.text + part.text,
      };
    } else {
      joined.push(part);
    }
  }
  return joined;
};

/** Parse a `from` path into literal and captured pieces. */
const parseFrom = (from: string): Parsed => {
  const segments = from.split("/").slice(1);
  const names = new Set<string>();
  const parts: Part[] = [];
  for (const [index, segment] of segments.entries()) {
    const next = segmentParts(segment, index === segments.length - 1, names);
    if ("error" in next) {
      return next;
    }
    parts.push(...next.parts);
  }
  return { parts: joinText(parts) };
};

/** The names a `from` captures. */
const capturedNames = (parts: readonly Part[]): Set<string> =>
  new Set(
    parts.flatMap((part) => {
      if (part.kind === "param" || part.kind === "rest") {
        return [part.name];
      }
      return part.kind === "splat" ? [SPLAT] : [];
    })
  );

/** The capture a `to` reference reads: `*` and `/*` read the splat. */
const referenceName = (name: string | undefined): string => name ?? SPLAT;

/**
 * `to` with each capture reference replaced: `replace` gets the name and
 * whether the reference is a whole segment (its slash included in what it
 * replaces).
 */
const replaceReferences = (
  to: string,
  replace: (name: string, segment: boolean) => string
): string =>
  to.replaceAll(REFERENCE, (match, name: string | undefined) =>
    replace(referenceName(name), match.startsWith("/"))
  );

/** Whether a path is a pattern, rather than one exact path. */
export const isPatternPath = (path: string): boolean => {
  const parsed = parseFrom(path);
  return "error" in parsed || parsed.parts.some((part) => part.kind !== "text");
};

/** Why a redirect's ends can't work, and which end to fix. */
export interface RedirectPatternError {
  end: "from" | "to";
  message: string;
}

/**
 * Why a redirect's ends can't work as a pattern, or `null` when they can:
 * `from` has a malformed capture, or `to` reads one `from` doesn't make.
 */
export const redirectPatternError = (
  from: string,
  to: string
): RedirectPatternError | null => {
  const parsed = parseFrom(from);
  if ("error" in parsed) {
    return { end: "from", message: parsed.error };
  }
  const names = capturedNames(parsed.parts);
  const unknown: string[] = [];
  replaceReferences(to, (name) => {
    if (!names.has(name)) {
      unknown.push(name);
    }
    return "";
  });
  const [first] = unknown;
  if (first === undefined) {
    return null;
  }
  const spelled = first === SPLAT ? "`*`" : `\`:${first}\``;
  return {
    end: "to",
    message: `\`to\` reads ${spelled}, which \`from\` doesn't capture.`,
  };
};

/**
 * `to` with a rest's capture filled with nothing, its references dropped
 * along with their slashes. Any other reference is to a one-segment
 * `:param` (a `from` holds one rest or `*` at most), so it stays.
 */
const dropCapture = (to: string, dropped: string): string => {
  const filled = replaceReferences(to, (name) =>
    name === dropped ? "" : `/:${name}`
  );
  return /^(?:[?#]|$)/u.test(filled) ? `/${filled}` : filled;
};

/** The pieces of a rule: a parsed `from` holds its rest last, if at all. */
const ruleParts = (parts: readonly Part[]): RulePart[] =>
  parts.filter((part): part is RulePart => part.kind !== "rest");

/**
 * The rules a redirect expands to, in the order to try them. A `from` ending
 * in a rest (`/:name*`, `/*`) becomes two: the bare path, its references
 * dropped, and the path with at least one more segment. Only a pattern has
 * rules; an exact redirect gets none.
 */
export const expandRedirect = (redirect: RedirectEnds): RedirectRule[] => {
  const parsed = parseFrom(redirect.from);
  if ("error" in parsed) {
    return [];
  }
  const { parts } = parsed;
  const last = parts.at(-1);
  if (last?.kind !== "rest") {
    const fixed = ruleParts(parts);
    return fixed.some((part) => part.kind !== "text")
      ? [{ parts: fixed, status: redirect.status, to: redirect.to }]
      : [];
  }
  const head = ruleParts(parts.slice(0, -1));
  const tail = joinText<RulePart>([...head, { kind: "text", text: "/" }]);
  return [
    {
      parts: head.length > 0 ? head : [{ kind: "text", text: "/" }],
      status: redirect.status,
      to: dropCapture(redirect.to, last.name),
    },
    {
      parts: [...tail, { kind: "tail", name: last.name }],
      status: redirect.status,
      to: redirect.to,
    },
  ];
};

/** Put exact redirects ahead of patterns, which hosts try in order. */
export const exactFirst = <Redirect extends { from: string }>(
  redirects: readonly Redirect[]
): Redirect[] => [
  ...redirects.filter((redirect) => !isPatternPath(redirect.from)),
  ...redirects.filter((redirect) => isPatternPath(redirect.from)),
];

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** The captures a rule makes, in order, by name. */
const captureNames = (parts: readonly RulePart[]): string[] =>
  parts.flatMap((part) => {
    if (part.kind === "param" || part.kind === "tail") {
      return [part.name];
    }
    return part.kind === "splat" ? [SPLAT] : [];
  });

/** A rule's path in `_redirects` syntax (Netlify, Cloudflare). */
const underscorePath = (parts: readonly RulePart[]): string =>
  parts
    .map((part) => {
      if (part.kind === "text") {
        return part.text;
      }
      return part.kind === "param" ? `:${part.name}` : "*";
    })
    .join("");

/** A rule as a `_redirects` `from` and `to`: rests and `*` are its splat. */
export const underscoreRedirect = (rule: RedirectRule) => {
  const splats = new Set(
    rule.parts.flatMap((part) => {
      if (part.kind === "tail") {
        return [part.name];
      }
      return part.kind === "splat" ? [SPLAT] : [];
    })
  );
  return {
    from: underscorePath(rule.parts),
    to: replaceReferences(rule.to, (name, segment) => {
      const spelled = splats.has(name) ? ":splat" : `:${name}`;
      return segment ? `/${spelled}` : spelled;
    }),
  };
};

/**
 * A rule as a `vercel.json` `source` and `destination` (`path-to-regexp`),
 * each literal run escaped by `escape` so it matches only itself.
 */
export const vercelRedirect = (
  rule: RedirectRule,
  escape: (path: string) => string
) => {
  const tails = new Set(
    rule.parts.flatMap((part) => (part.kind === "tail" ? [part.name] : []))
  );
  const source = rule.parts
    .map((part) => {
      if (part.kind === "text") {
        return escape(part.text);
      }
      if (part.kind === "param") {
        return `:${part.name}`;
      }
      return part.kind === "tail" ? `:${part.name}+` : `:${SPLAT}(.*)`;
    })
    .join("");
  return {
    destination: replaceReferences(rule.to, (name, segment) => {
      const spelled = tails.has(name) ? `:${name}+` : `:${name}`;
      return segment ? `/${spelled}` : spelled;
    }),
    source,
  };
};

const REGEX_SYNTAX = /[$()*+.?[\\\]^{|}]/gu;

/**
 * A rule as a regular expression source over the decoded path (JavaScript
 * and PCRE alike), a trailing slash optional, and its `to` with each capture
 * a numbered `$n`. What Vercel's routing config and the server wrappers
 * match with.
 */
export const regexRedirect = (rule: RedirectRule) => {
  const lastIndex = rule.parts.length - 1;
  const body = rule.parts
    .map((part, index) => {
      if (part.kind === "text") {
        // The optional trailing slash is added once, below.
        const literal =
          index === lastIndex && index > 0
            ? part.text.replace(/\/$/u, "")
            : part.text;
        return literal.replaceAll(REGEX_SYNTAX, String.raw`\$&`);
      }
      if (part.kind === "param") {
        return "([^/]+)";
      }
      return part.kind === "tail" ? "(.+?)" : "(.*?)";
    })
    .join("");
  const names = captureNames(rule.parts);
  return {
    location: replaceReferences(rule.to, (name, segment) => {
      const reference = `$${names.indexOf(name) + 1}`;
      return segment ? `/${reference}` : reference;
    }),
    source: body === "/" ? "^/$" : `^${body}/?$`,
  };
};

/** A pattern redirect as the server wrappers carry it: regex source, `Location` template, status. */
export type CompiledRedirect = [
  source: string,
  location: string,
  status: number,
];

/** One rule, compiled (see {@link compileRedirects}). */
const compileRule = (rule: RedirectRule): CompiledRedirect => {
  const { location, source } = regexRedirect(rule);
  return [source, encodeURI(location), rule.status];
};

/**
 * The pattern redirects among `redirects`, compiled for the server wrappers
 * and Vercel's routing config, in the order to try them. The `Location`
 * template is percent-encoded as the header needs; a capture is encoded when
 * it's filled (see {@link fillLocation}).
 */
export const compileRedirects = (
  redirects: readonly RedirectEnds[]
): CompiledRedirect[] => redirects.flatMap(expandRedirect).map(compileRule);

/**
 * Every redirect among `redirects` compiled, exact paths first: a pattern as
 * {@link compileRedirects} compiles it, an exact path as a rule matching
 * just that path, a trailing slash optional. What the dev server answers
 * with, where Astro's own handler would send an exact redirect to a page
 * served by `[...slug]` as a `301` whatever its status.
 */
export const compileEveryRedirect = (
  redirects: readonly RedirectEnds[]
): CompiledRedirect[] =>
  exactFirst(redirects)
    .flatMap((redirect) => {
      const rules = expandRedirect(redirect);
      return rules.length > 0
        ? rules
        : [
            {
              parts: [{ kind: "text", text: normalizePath(redirect.from) }],
              status: redirect.status,
              to: redirect.to,
            } satisfies RedirectRule,
          ];
    })
    .map(compileRule);

/** A captured value, encoded for a `Location` header that must not grow a query or fragment. */
export const encodeCapture = (value: string): string =>
  encodeURI(value).replaceAll("?", "%3F").replaceAll("#", "%23");

/** A `Location` template with its `$n` references filled from `match`. */
export const fillLocation = (
  location: string,
  match: RegExpExecArray
): string =>
  location.replaceAll(/\$(?<index>\d+)/gu, (_reference, index: string) =>
    encodeCapture(match[Number(index)] ?? "")
  );

/**
 * The `Location` and status the first compiled redirect matching a decoded
 * path answers with, or `null` when none does.
 */
export const matchCompiledRedirect = (
  compiled: readonly CompiledRedirect[],
  path: string
): [location: string, status: number] | null => {
  for (const [source, location, status] of compiled) {
    const match = new RegExp(source, "u").exec(path);
    if (match) {
      return [fillLocation(location, match), status];
    }
  }
  return null;
};

/** A request URL's path, decoded; a malformed escape leaves it as sent. */
export const requestPath = (url: string): string => {
  const [path = ""] = url.split(/[?#]/u, 1);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * Where a pattern redirect sends a decoded path, unencoded, or `undefined`
 * when none matches: what the link checks follow.
 */
export const patternDestination = (
  redirects: readonly RedirectEnds[],
  path: string
): string | undefined => {
  for (const rule of redirects.flatMap(expandRedirect)) {
    const { location, source } = regexRedirect(rule);
    const match = new RegExp(source, "u").exec(path);
    if (match) {
      return location.replaceAll(
        /\$(?<index>\d+)/gu,
        (_reference, index: string) => match[Number(index)] ?? ""
      );
    }
  }
  return undefined;
};

/**
 * The paths a pattern `from` matches, of those given; none for an exact
 * `from`. Only the match matters here, so the rules' destinations are moot.
 */
export const pathsUnderPattern = (
  from: string,
  paths: readonly string[]
): string[] => {
  const sources = expandRedirect({ from, status: 0, to: "/" }).map(
    (rule) => new RegExp(regexRedirect(rule).source, "u")
  );
  return paths.filter((path) => sources.some((source) => source.test(path)));
};
