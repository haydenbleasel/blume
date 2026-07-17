/**
 * Security (authorization) resolution for the OpenAPI components. An operation
 * enforces its own `security` when declared — an empty array explicitly makes
 * it public — and inherits the document's root `security` otherwise. Within the
 * resolved list, each requirement object is one way to authorize (OR between
 * entries), and every scheme named inside a single requirement is needed
 * together (AND). Pure and dependency-free like `helpers.ts`, so it runs in the
 * browser build with no server-only imports.
 */

/** A permissive view of an OpenAPI security scheme — only the fields we render. */
export interface SecuritySchemeLike {
  type?: string;
  description?: string;
  /** `apiKey`: the parameter name the key is sent as. */
  name?: string;
  /** `apiKey`: where the key goes — `header`, `query`, or `cookie`. */
  in?: string;
  /** `http`: the HTTP auth scheme, e.g. `bearer` or `basic`. */
  scheme?: string;
  /** `http` bearer: a hint at the token format, e.g. `JWT`. */
  bearerFormat?: string;
  [key: string]: unknown;
}

/** One security requirement: scheme name -> required scopes (empty outside OAuth). */
export type SecurityRequirementLike = Record<string, string[]>;

/** A scheme resolved out of `components.securitySchemes`, with its scopes. */
export interface ResolvedScheme {
  /** The scheme's component name, e.g. `bearerAuth`. */
  key: string;
  /** The scheme object; undefined when the requirement names an unknown one. */
  scheme?: SecuritySchemeLike;
  scopes: string[];
}

/** The security state one operation renders. */
export interface OperationSecurity {
  /** Ways to authorize (OR); every scheme within one entry is required (AND). */
  alternatives: ResolvedScheme[][];
  /** True when an empty requirement also allows unauthenticated calls. */
  optional: boolean;
}

/**
 * The requirement list an operation actually enforces: its own `security` when
 * declared — the OpenAPI override rule, where `[]` removes the default and
 * makes the operation public — else the document's root `security`.
 */
export const effectiveSecurity = (
  operation?: SecurityRequirementLike[],
  document?: SecurityRequirementLike[]
): SecurityRequirementLike[] => operation ?? document ?? [];

/**
 * Resolve requirement names against `components.securitySchemes`. A name with
 * no matching component is kept (with `scheme` undefined) so an inconsistent
 * spec still renders the requirement instead of silently dropping it. An empty
 * requirement object — the spec idiom for "auth optional" — contributes no
 * alternative and flips `optional` instead.
 */
export const resolveSecurity = (
  requirements: SecurityRequirementLike[],
  schemes: Record<string, SecuritySchemeLike> | undefined
): OperationSecurity => {
  const alternatives: ResolvedScheme[][] = [];
  let optional = false;
  for (const requirement of requirements) {
    const entries = Object.entries(requirement ?? {});
    if (entries.length === 0) {
      optional = true;
      continue;
    }
    alternatives.push(
      entries.map(([key, scopes]) => ({
        key,
        scheme: schemes?.[key],
        scopes: Array.isArray(scopes)
          ? scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
      }))
    );
  }
  return { alternatives, optional };
};

const capitalize = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** A short human label for a scheme row, e.g. `Bearer token` or `API key`. */
export const schemeLabel = (resolved: ResolvedScheme): string => {
  const { scheme } = resolved;
  switch (scheme?.type) {
    case "http": {
      const kind = (scheme.scheme ?? "").toLowerCase();
      if (kind === "bearer") {
        return scheme.bearerFormat
          ? `Bearer token (${scheme.bearerFormat})`
          : "Bearer token";
      }
      if (kind === "basic") {
        return "Basic auth";
      }
      return kind ? `HTTP ${kind}` : "HTTP auth";
    }
    case "apiKey": {
      return "API key";
    }
    case "oauth2": {
      return "OAuth2 access token";
    }
    case "openIdConnect": {
      return "OpenID Connect token";
    }
    case "mutualTLS": {
      return "Mutual TLS";
    }
    default: {
      // Unknown scheme ref: the component name is the best label available.
      return resolved.key;
    }
  }
};

/**
 * Where the credential travels: the header/query/cookie parameter it occupies.
 * Undefined for schemes with no request parameter (mutual TLS) and for unknown
 * refs, where guessing a location would be misleading.
 */
export const schemeCarrier = (
  resolved: ResolvedScheme
): { name: string; in: string } | undefined => {
  const { scheme } = resolved;
  switch (scheme?.type) {
    case "http":
    case "oauth2":
    case "openIdConnect": {
      return { in: "header", name: "Authorization" };
    }
    case "apiKey": {
      return { in: scheme.in ?? "header", name: scheme.name ?? resolved.key };
    }
    default: {
      return undefined;
    }
  }
};

/** Placeholder credentials the request samples send. */
export interface SampleAuth {
  headers: Record<string, string>;
  query: Record<string, string>;
}

/**
 * Placeholder credentials for an operation's request samples, from its first
 * alternative (the spec's preferred way to authorize). Schemes that don't
 * travel in the request (mutual TLS) and unknown refs contribute nothing.
 */
export const sampleAuth = (security: OperationSecurity): SampleAuth => {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const cookies: string[] = [];
  for (const resolved of security.alternatives[0] ?? []) {
    const { scheme } = resolved;
    switch (scheme?.type) {
      case "http": {
        const kind = (scheme.scheme ?? "bearer").toLowerCase();
        headers.Authorization =
          kind === "bearer"
            ? "Bearer YOUR_TOKEN"
            : `${capitalize(kind)} YOUR_CREDENTIALS`;
        break;
      }
      case "oauth2":
      case "openIdConnect": {
        headers.Authorization = "Bearer YOUR_ACCESS_TOKEN";
        break;
      }
      case "apiKey": {
        const name = scheme.name ?? resolved.key;
        if (scheme.in === "query") {
          query[name] = "YOUR_API_KEY";
        } else if (scheme.in === "cookie") {
          cookies.push(`${name}=YOUR_API_KEY`);
        } else {
          headers[name] = "YOUR_API_KEY";
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  if (cookies.length > 0) {
    headers.Cookie = cookies.join("; ");
  }
  return { headers, query };
};
