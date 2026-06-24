/** Minimal AsyncAPI 3.x shapes — only the parts Blume's importer reads. */

export interface AsyncApiReference {
  $ref: string;
}

export interface AsyncApiSchema {
  $ref?: string;
  title?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, AsyncApiSchema | AsyncApiReference>;
  required?: string[];
  items?: AsyncApiSchema | AsyncApiReference;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  oneOf?: (AsyncApiSchema | AsyncApiReference)[];
  anyOf?: (AsyncApiSchema | AsyncApiReference)[];
  allOf?: (AsyncApiSchema | AsyncApiReference)[];
}

export interface AsyncApiMessage {
  $ref?: string;
  name?: string;
  title?: string;
  summary?: string;
  description?: string;
  payload?: AsyncApiSchema | AsyncApiReference;
}

export interface AsyncApiOperation {
  $ref?: string;
  action?: string;
  title?: string;
  summary?: string;
  description?: string;
  channel?: AsyncApiChannel | AsyncApiReference;
  messages?:
    | (AsyncApiMessage | AsyncApiReference)[]
    | Record<string, AsyncApiMessage | AsyncApiReference>;
}

export interface AsyncApiChannel {
  $ref?: string;
  address?: string;
  title?: string;
  summary?: string;
  description?: string;
  messages?: Record<string, AsyncApiMessage | AsyncApiReference>;
  publish?: AsyncApiOperation | AsyncApiReference;
  subscribe?: AsyncApiOperation | AsyncApiReference;
}

export interface AsyncApiDocument {
  asyncapi?: string;
  info?: { title?: string; description?: string; version?: string };
  channels?: Record<string, AsyncApiChannel | AsyncApiReference>;
  operations?: Record<string, AsyncApiOperation | AsyncApiReference>;
  components?: {
    channels?: Record<string, AsyncApiChannel | AsyncApiReference>;
    messages?: Record<string, AsyncApiMessage | AsyncApiReference>;
    schemas?: Record<string, AsyncApiSchema | AsyncApiReference>;
  };
}
