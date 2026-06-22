/** Minimal OpenAPI 3.x shapes — only the parts Blume's importer reads. */

export interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  example?: unknown;
  enum?: unknown[];
}

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    description?: string;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
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
