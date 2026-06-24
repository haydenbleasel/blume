/** Minimal OpenAPI 3.x shapes — only the parts Blume's importer reads. */

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  title?: string;
  format?: string;
  description?: string;
  default?: unknown;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  example?: unknown;
  enum?: unknown[];
  deprecated?: boolean;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  "x-default"?: unknown;
  "x-mint"?: OpenApiMintExtension;
  [key: string]: unknown;
}

export interface OpenApiSecurityScheme {
  type?: string;
  description?: string;
  in?: string;
  name?: string;
  scheme?: string;
  "x-default"?: unknown;
}

export type OpenApiSecurityRequirement = Record<string, string[]>;

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  example?: unknown;
  schema?: OpenApiSchema;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
  examples?: Record<string, { summary?: string; value?: unknown }>;
}

export interface OpenApiServer {
  url?: string;
}

export interface OpenApiTag {
  name?: string;
  description?: string;
  "x-group"?: unknown;
}

export interface OpenApiMintMetadata {
  groups?: unknown;
  playground?: unknown;
  public?: unknown;
  [key: string]: unknown;
}

export interface OpenApiMintExtension {
  content?: unknown;
  groups?: unknown;
  href?: unknown;
  metadata?: OpenApiMintMetadata;
  post?: unknown;
  pre?: unknown;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

export type OpenApiCallback = Record<string, OpenApiPathItem>;

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  callbacks?: Record<string, OpenApiCallback>;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    description?: string;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
  security?: OpenApiSecurityRequirement[];
  servers?: OpenApiServer[];
  "x-excluded"?: boolean;
  "x-hidden"?: boolean;
  "x-mint"?: OpenApiMintExtension;
}

export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & {
  servers?: OpenApiServer[];
  "x-mint"?: OpenApiMintExtension;
};

export interface OpenApiDocument {
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  paths?: Record<string, OpenApiPathItem>;
  security?: OpenApiSecurityRequirement[];
  servers?: OpenApiServer[];
  tags?: OpenApiTag[];
  webhooks?: Record<string, OpenApiPathItem>;
}

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
