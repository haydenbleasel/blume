import matter from "gray-matter";

import type { ResolvedConfig } from "../core/schema.ts";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;
const LEADING_MDX_ESM = /^(?:(?:import|export)\s+.+(?:\r?\n|$)|\s*\r?\n)+/u;
const LEADING_H1 = /^(?<heading>#\s+.*(?:\r?\n|$))(?:\r?\n)?/u;

type HttpMethod = (typeof HTTP_METHODS)[number];

interface ManualApiEndpoint {
  method: HttpMethod;
  path: string;
  server?: string;
}

const isHttpMethod = (value: string | undefined): value is HttpMethod =>
  HTTP_METHODS.includes(value?.toUpperCase() as HttpMethod);

const normalizePath = (value: string): string =>
  value.startsWith("/") ? value : `/${value}`;

const splitFullUrl = (
  value: string
): { path: string; server: string } | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return {
      path: `${url.pathname || "/"}${url.search}`,
      server: url.origin,
    };
  } catch {
    return null;
  }
};

const parseManualApiEndpoint = (
  value: unknown,
  api: ResolvedConfig["api"]
): ManualApiEndpoint | undefined => {
  if (typeof value === "string") {
    const [method, ...targetParts] = value.trim().split(/\s+/u);
    if (!isHttpMethod(method) || targetParts.length === 0) {
      return undefined;
    }
    const target = targetParts.join(" ");
    const fullUrl = splitFullUrl(target);
    return {
      method: method.toUpperCase() as HttpMethod,
      path: fullUrl?.path ?? normalizePath(target),
      server: fullUrl?.server ?? api.mdx.server,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const method =
    typeof object.method === "string" ? object.method.toUpperCase() : undefined;
  const path = typeof object.path === "string" ? object.path : undefined;
  if (!isHttpMethod(method) || !path) {
    return undefined;
  }
  const fullUrl = splitFullUrl(path);
  return {
    method,
    path: fullUrl?.path ?? normalizePath(path),
    server: fullUrl?.server ?? api.mdx.server,
  };
};

const renderEndpoint = (
  endpoint: ManualApiEndpoint,
  frontmatter: Record<string, unknown>
): string => {
  const props = [
    `method=${JSON.stringify(endpoint.method)}`,
    `path={${JSON.stringify(endpoint.path)}}`,
    frontmatter.deprecated === true ? "deprecated={true}" : undefined,
    endpoint.server ? `server={${JSON.stringify(endpoint.server)}}` : undefined,
    "tryIt={false}",
  ].filter((prop): prop is string => typeof prop === "string");
  return `<Endpoint ${props.join(" ")} />`;
};

const renderManualApiContent = (
  endpoint: ManualApiEndpoint,
  frontmatter: Record<string, unknown>
): string => renderEndpoint(endpoint, frontmatter);

const insertGeneratedContent = (source: string, generated: string): string => {
  const frontmatter = source.match(FRONTMATTER_BLOCK)?.[0] ?? "";
  const body = frontmatter ? source.slice(frontmatter.length) : source;
  const esm = body.match(LEADING_MDX_ESM)?.[0] ?? "";
  const rest = body.slice(esm.length);
  const h1 = rest.match(LEADING_H1)?.[0] ?? "";
  const insertionPoint = frontmatter + esm + h1;
  const remaining = rest.slice(h1.length).replace(/^\r?\n/u, "");
  return `${`${insertionPoint}${generated.trim()}\n\n${remaining}`.trimEnd()}\n`;
};

/** Expand Mintlify `api` frontmatter pages into endpoint chrome. */
export const rewriteMintlifyManualApiPage = (
  source: string,
  options: { api: ResolvedConfig["api"] }
): string => {
  const parsed = matter(source);
  const endpoint = parseManualApiEndpoint(parsed.data.api, options.api);
  if (!endpoint) {
    return source;
  }
  const generated = renderManualApiContent(endpoint, parsed.data);
  return insertGeneratedContent(source, generated);
};
