import { mkdir, readFile, writeFile } from "node:fs/promises";

import { dirname, join, relative, resolve } from "pathe";
import { parse as parseYaml } from "yaml";

import { HTTP_METHODS } from "./types.ts";
import type {
  HttpMethod,
  OpenApiDocument,
  OpenApiMediaType,
  OpenApiMintExtension,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiServer,
} from "./types.ts";

const NON_SLUG = /[^a-z0-9]+/gu;
const CAMEL_ACRONYM_BOUNDARY = /(?<=[A-Z])(?=[A-Z][a-z])/gu;
const CAMEL_WORD_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/gu;

const slugify = (value: string): string =>
  value
    .replaceAll(CAMEL_ACRONYM_BOUNDARY, "-")
    .replaceAll(CAMEL_WORD_BOUNDARY, "-")
    .toLowerCase()
    .replace(NON_SLUG, "-")
    .replaceAll(/^-|-$/gu, "");

const operationSlug = (
  method: string,
  path: string,
  operation: OpenApiOperation
): string =>
  operation.operationId
    ? slugify(operation.operationId)
    : slugify(`${method}-${path}`);

export const operationPageSlug = (
  method: string,
  path: string,
  operation: OpenApiOperation
): string => operationSlug(method, path, operation);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const decodePointerSegment = (value: string): string =>
  value.replaceAll("~1", "/").replaceAll("~0", "~");

const isSchemaReference = (
  schema: OpenApiSchema | undefined
): schema is OpenApiSchema & { $ref: string } =>
  typeof schema?.$ref === "string" && schema.$ref.length > 0;

const refName = (schema: OpenApiSchema): string | undefined =>
  schema.$ref?.split("/").at(-1);

const localRefValue = (
  doc: OpenApiDocument | undefined,
  ref: string
): unknown => {
  if (!doc || !ref.startsWith("#/")) {
    return undefined;
  }

  let current: unknown = doc;
  for (const segment of ref.slice(2).split("/").map(decodePointerSegment)) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const resolveSchema = (
  doc: OpenApiDocument | undefined,
  schema: OpenApiSchema | undefined,
  seen = new Set<string>()
): OpenApiSchema | undefined => {
  if (!isSchemaReference(schema)) {
    return schema;
  }
  if (seen.has(schema.$ref)) {
    return undefined;
  }
  seen.add(schema.$ref);
  return resolveSchema(
    doc,
    localRefValue(doc, schema.$ref) as OpenApiSchema | undefined,
    seen
  );
};

const mergeResolvedSchema = (
  schema: OpenApiSchema | undefined,
  resolved: OpenApiSchema | undefined
): OpenApiSchema | undefined =>
  schema && resolved && schema !== resolved
    ? { ...resolved, ...schema }
    : (resolved ?? schema);

const operationHref = (
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined
): string | undefined =>
  stringValue(operation["x-mint"]?.href) ??
  stringValue(pathItem?.["x-mint"]?.href);

export interface OpenApiOperationGroup {
  label: string;
  slug: string;
}

export interface OpenApiOperationPage {
  group?: OpenApiOperationGroup;
  href?: string;
  hidden: boolean;
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  slug: string;
}

const isOperationExcluded = (
  operation: OpenApiOperation | undefined
): boolean => operation?.["x-excluded"] === true;

export interface OpenApiGenerationOptions {
  examples?: {
    autogenerate?: boolean;
    defaults?: "required" | "all";
    prefill?: boolean;
  };
  params?: {
    post?: string[];
  };
  rootDir?: string;
}

export const listOpenApiOperations = (
  doc: OpenApiDocument
): OpenApiOperationPage[] => {
  const operations: OpenApiOperationPage[] = [];
  const tags = new Map(
    (doc.tags ?? []).flatMap((tag) => (tag.name ? [[tag.name, tag]] : []))
  );
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = methods[method];
      if (!operation || isOperationExcluded(operation)) {
        continue;
      }
      const href = operationHref(operation, methods);
      const tagName = operation.tags?.find((tag) => tag.length > 0);
      const tag = tagName ? tags.get(tagName) : undefined;
      const group =
        tagName && !href
          ? {
              label: stringValue(tag?.["x-group"]) ?? tagName,
              slug: slugify(tagName),
            }
          : undefined;
      operations.push({
        ...(group?.slug ? { group } : {}),
        ...(href ? { href } : {}),
        hidden: operation["x-hidden"] === true,
        method,
        operation,
        path,
        slug: operationSlug(method, path, operation),
      });
    }
  }
  return operations;
};

const configuredPillValue = (
  key: string,
  value: unknown
): string | undefined => {
  if (value === true) {
    return key;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
};

const listValue = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
};

const stringListValue = (value: unknown): string[] =>
  listValue(value)
    .filter((item): item is string => typeof item === "string")
    .filter(
      (item, index, items) => item.length > 0 && items.indexOf(item) === index
    );

const configuredPostPills = (
  schema: OpenApiSchema | undefined,
  options: OpenApiGenerationOptions
): string[] =>
  (options.params?.post ?? []).flatMap((key) => {
    const label = configuredPillValue(key, schema?.[key]);
    return label ? [label] : [];
  });

const schemaPills = (
  schema: OpenApiSchema | undefined,
  options: OpenApiGenerationOptions
): { post: string[]; pre: string[] } => {
  const extension = schema?.["x-mint"];
  const post = [
    ...(schema?.readOnly ? ["read-only"] : []),
    ...(schema?.writeOnly ? ["write-only"] : []),
    ...configuredPostPills(schema, options),
    ...stringListValue(extension?.post),
  ].filter((item, index, items) => items.indexOf(item) === index);
  return {
    post,
    pre: stringListValue(extension?.pre),
  };
};

interface ParameterRow {
  deprecated: boolean;
  description?: string;
  name: string;
  post: string[];
  pre: string[];
  required: boolean;
  type?: string;
}

const displaySchemaType = (
  doc: OpenApiDocument | undefined,
  schema: OpenApiSchema | undefined,
  seen = new Set<string>()
): string | undefined => {
  const resolved = resolveSchema(doc, schema, seen);
  const current = mergeResolvedSchema(schema, resolved);
  if (!current) {
    return undefined;
  }
  const { type } = current;
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  if (type === "array" || current.items) {
    return `${displaySchemaType(doc, current.items, new Set(seen)) ?? "object"}[]`;
  }
  if (type) {
    return type;
  }
  if (current.oneOf) {
    return "oneOf";
  }
  if (current.anyOf) {
    return "anyOf";
  }
  if (current.allOf || current.properties) {
    return "object";
  }
  if (current.enum) {
    return "enum";
  }
  return refName(current) ?? "object";
};

const schemaTitle = (
  doc: OpenApiDocument | undefined,
  schema: OpenApiSchema | undefined,
  fallback: string
): string =>
  stringValue(resolveSchema(doc, schema, new Set())?.title) ?? fallback;

const joinParameterPath = (prefix: string | undefined, name: string): string =>
  prefix ? `${prefix}.${name}` : name;

const isArraySchema = (schema: OpenApiSchema | undefined): boolean => {
  const type = schema?.type;
  return (
    type === "array" ||
    (Array.isArray(type) && type.includes("array")) ||
    Boolean(schema?.items)
  );
};

const schemaPropertyRows = (
  schema: OpenApiSchema | undefined,
  options: OpenApiGenerationOptions,
  doc: OpenApiDocument | undefined,
  prefix?: string,
  seen = new Set<string>()
): ParameterRow[] => {
  const resolved = resolveSchema(doc, schema, seen);
  const current = mergeResolvedSchema(schema, resolved);
  if (!current) {
    return [];
  }

  const propertyRows = (
    name: string,
    property: OpenApiSchema,
    required: boolean
  ): ParameterRow[] => {
    const branchSeen = new Set(seen);
    const propertyResolved = resolveSchema(doc, property, branchSeen);
    const propertySchema = mergeResolvedSchema(property, propertyResolved);
    const parameterName = joinParameterPath(prefix, name);
    const pills = schemaPills(propertySchema, options);
    const row = {
      deprecated: propertySchema?.deprecated ?? false,
      description: propertySchema?.description,
      name: parameterName,
      post: pills.post,
      pre: pills.pre,
      required,
      type: displaySchemaType(doc, propertySchema, branchSeen),
    };
    const arraySchema = isArraySchema(propertySchema);
    const childPrefix = arraySchema ? `${parameterName}[]` : parameterName;
    const childSchema = arraySchema ? propertySchema?.items : propertySchema;
    return [
      row,
      ...schemaPropertyRows(childSchema, options, doc, childPrefix, branchSeen),
    ];
  };

  const required = new Set(current.required);
  const ownRows = Object.entries(current.properties ?? {}).flatMap(
    ([name, property]) => propertyRows(name, property, required.has(name))
  );
  const allOfRows = (current.allOf ?? []).flatMap((item) =>
    schemaPropertyRows(item, options, doc, prefix, new Set(seen))
  );
  const oneOfRows = (current.oneOf ?? current.anyOf ?? []).flatMap(
    (item, index) =>
      schemaPropertyRows(
        item,
        options,
        doc,
        joinParameterPath(prefix, schemaTitle(doc, item, `option${index + 1}`)),
        new Set(seen)
      )
  );
  return [...ownRows, ...allOfRows, ...oneOfRows];
};

/** Flatten a JSON schema's properties into displayable parameter rows. */
const schemaToParameters = (
  schema: OpenApiSchema | undefined,
  options: OpenApiGenerationOptions,
  doc?: OpenApiDocument
): ParameterRow[] => schemaPropertyRows(schema, options, doc);

const paramsToRows = (
  parameters: OpenApiParameter[],
  options: OpenApiGenerationOptions
): ParameterRow[] =>
  parameters.map((parameter) => {
    const pills = schemaPills(parameter.schema, options);
    return {
      deprecated:
        parameter.deprecated === true || parameter.schema?.deprecated === true,
      description: parameter.description ?? parameter.schema?.description,
      name: parameter.name,
      post: pills.post,
      pre: pills.pre,
      required: parameter.required ?? false,
      type: displaySchemaType(undefined, parameter.schema) ?? "string",
    };
  });

const exampleBlock = (value: unknown): string =>
  ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

const jsonMime = "application/json";

const firstServerUrl = (
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined,
  doc: OpenApiDocument
): string | undefined => {
  const servers: (OpenApiServer | undefined)[] = [
    operation.servers?.[0],
    pathItem?.servers?.[0],
    doc.servers?.[0],
  ];
  return servers.find((server) => server?.url)?.url;
};

export const listOpenApiServerUrls = (doc: OpenApiDocument): string[] => {
  const servers = new Set<string>();
  for (const server of doc.servers ?? []) {
    if (server.url) {
      servers.add(server.url);
    }
  }
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const server of pathItem.servers ?? []) {
      if (server.url) {
        servers.add(server.url);
      }
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || isOperationExcluded(operation)) {
        continue;
      }
      const server = firstServerUrl(operation, pathItem, doc);
      if (server) {
        servers.add(server);
      }
      // Operations can override the path-level server with multiple choices.
      for (const operationServer of operation.servers ?? []) {
        if (operationServer.url) {
          servers.add(operationServer.url);
        }
      }
    }
  }
  return [...servers];
};

const requestUrl = (server: string | undefined, path: string): string =>
  server ? `${server.replace(/\/$/u, "")}${path}` : path;

interface MintlifyOperationMetadata {
  content?: string;
  description?: string;
  groups: string[];
  href?: string;
  playground?: string;
  public?: boolean;
  sidebarTitle?: string;
  title?: string;
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\"'\"'")}'`;

const requestBodyExample = (operation: OpenApiOperation): unknown => {
  const media = operation.requestBody?.content?.[jsonMime];
  return (
    media?.example ??
    Object.values(media?.examples ?? {})[0]?.value ??
    media?.schema?.example
  );
};

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const mintlifyMetadata = (
  extension: OpenApiMintExtension | undefined
): MintlifyOperationMetadata => ({
  content: stringValue(extension?.content),
  description: stringValue(extension?.metadata?.description),
  groups: [
    ...stringListValue(extension?.groups),
    ...stringListValue(extension?.metadata?.groups),
  ].filter((item, index, items) => items.indexOf(item) === index),
  href: stringValue(extension?.href),
  playground: stringValue(extension?.metadata?.playground),
  public: booleanValue(extension?.metadata?.public),
  sidebarTitle: stringValue(extension?.metadata?.sidebarTitle),
  title: stringValue(extension?.metadata?.title),
});

const operationMetadata = (
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined
): MintlifyOperationMetadata => {
  const pathMetadata = mintlifyMetadata(pathItem?.["x-mint"]);
  const operationMeta = mintlifyMetadata(operation["x-mint"]);
  return {
    content: operationMeta.content ?? pathMetadata.content,
    description: operationMeta.description ?? pathMetadata.description,
    groups:
      operationMeta.groups.length > 0
        ? operationMeta.groups
        : pathMetadata.groups,
    href: operationMeta.href ?? pathMetadata.href,
    playground: operationMeta.playground ?? pathMetadata.playground,
    public: operationMeta.public ?? pathMetadata.public,
    sidebarTitle: operationMeta.sidebarTitle ?? pathMetadata.sidebarTitle,
    title: operationMeta.title ?? pathMetadata.title,
  };
};

const curlRequest = (
  method: string,
  path: string,
  operation: OpenApiOperation,
  server: string | undefined
): string => {
  const lines = [
    `curl --request ${method.toUpperCase()} \\`,
    `  --url ${shellQuote(requestUrl(server, path))}`,
  ];
  const bodyExample = requestBodyExample(operation);
  if (bodyExample !== undefined) {
    lines[lines.length - 1] = `${lines.at(-1)} \\`;
    lines.push(`  --header ${shellQuote("Content-Type: application/json")} \\`);
    lines.push(`  --data ${shellQuote(JSON.stringify(bodyExample))}`);
  }
  return ["```bash", ...lines, "```"].join("\n");
};

const paramTable = (
  title: string,
  rows: ReturnType<typeof paramsToRows>
): string[] =>
  rows.length > 0
    ? [
        `<ParameterTable title=${JSON.stringify(title)} parameters={${JSON.stringify(rows)}} />`,
        "",
      ]
    : [];

const markdownHeading = (depth: number, title: string): string =>
  `${"#".repeat(Math.min(Math.max(depth, 1), 6))} ${title}`;

export const renderOpenApiSchemaContent = (
  doc: OpenApiDocument,
  schemaName: string,
  options: OpenApiGenerationOptions & { headingDepth?: number } = {}
): string | undefined => {
  const schema = doc.components?.schemas?.[schemaName];
  if (!schema) {
    return undefined;
  }
  const resolved = resolveSchema(doc, schema, new Set());
  const current = mergeResolvedSchema(schema, resolved);
  const title = stringValue(current?.title) ?? schemaName;
  const type = displaySchemaType(doc, current, new Set());
  const rows = schemaToParameters(current, options, doc);
  const lines = [markdownHeading(options.headingDepth ?? 1, title), ""];
  if (current?.description) {
    lines.push(current.description, "");
  }
  if (type) {
    lines.push(`**Type:** \`${type}\``, "");
  }
  lines.push(...paramTable("Properties", rows));
  return `${lines.join("\n").trimEnd()}\n`;
};

interface OperationDisplay {
  description?: string;
  endpointProps: string[];
  title: string;
  upper: string;
}

const operationDisplay = (
  method: string,
  path: string,
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined,
  server: string | undefined,
  options: OpenApiGenerationOptions
): OperationDisplay => {
  const upper = method.toUpperCase();
  const metadata = operationMetadata(operation, pathItem);
  const title = metadata.title ?? operation.summary ?? `${upper} ${path}`;
  const description = metadata.description ?? operation.description;
  const hasRequestExample = options.examples?.autogenerate !== false;
  const endpointProps = [
    `method=${JSON.stringify(upper)}`,
    `path={${JSON.stringify(path)}}`,
    operation.deprecated ? "deprecated={true}" : undefined,
    server ? `server={${JSON.stringify(server)}}` : undefined,
    hasRequestExample
      ? 'requestExampleId="blume-request-example"'
      : "tryIt={false}",
  ].filter((prop): prop is string => typeof prop === "string");
  return {
    description,
    endpointProps,
    title,
    upper,
  };
};

const renderEndpoint = (
  endpointProps: string[],
  description: string | undefined
): string[] => {
  const lines = [`<Endpoint ${endpointProps.join(" ")} />`, ""];
  if (description) {
    lines.push(description, "");
  }
  return lines;
};

const renderFrontmatter = (
  method: string,
  path: string,
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined,
  server: string | undefined,
  options: OpenApiGenerationOptions
): string[] => {
  const display = operationDisplay(
    method,
    path,
    operation,
    pathItem,
    server,
    options
  );
  const metadata = operationMetadata(operation, pathItem);
  const lines = ["---", `title: ${JSON.stringify(display.title)}`];
  if (display.description) {
    lines.push(`description: ${JSON.stringify(display.description)}`);
  }
  if (metadata.sidebarTitle) {
    lines.push(`sidebarTitle: ${JSON.stringify(metadata.sidebarTitle)}`);
  }
  if (metadata.groups.length > 0) {
    lines.push(`groups: ${JSON.stringify(metadata.groups)}`);
  }
  if (metadata.public === true) {
    lines.push("public: true");
  }
  if (metadata.playground) {
    lines.push(`playground: ${JSON.stringify(metadata.playground)}`);
  }
  if (operation["x-hidden"] === true) {
    lines.push("hidden: true");
  }
  if (operation.deprecated) {
    lines.push("deprecated: true");
  }
  lines.push(
    "type: api",
    "api:",
    `  method: ${display.upper}`,
    `  path: ${JSON.stringify(path)}`,
    "---",
    "",
    `# ${display.title}`,
    ""
  );
  lines.push(...renderEndpoint(display.endpointProps, display.description));
  return lines;
};

const renderParameters = (
  operation: OpenApiOperation,
  options: OpenApiGenerationOptions
): string[] => {
  const params = operation.parameters ?? [];
  return [
    ...paramTable(
      "Path parameters",
      paramsToRows(
        params.filter((p) => p.in === "path"),
        options
      )
    ),
    ...paramTable(
      "Query parameters",
      paramsToRows(
        params.filter((p) => p.in === "query"),
        options
      )
    ),
  ];
};

const renderRequestBody = (
  operation: OpenApiOperation,
  options: OpenApiGenerationOptions,
  doc: OpenApiDocument
): string[] => {
  const media = operation.requestBody?.content?.[jsonMime];
  const lines = paramTable(
    "Body",
    schemaToParameters(media?.schema, options, doc)
  );
  const example = requestBodyExample(operation);
  if (example !== undefined) {
    lines.push(exampleBlock(example), "");
  }
  return lines;
};

const renderMintlifyContent = (
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined
): string[] => {
  const content = operationMetadata(operation, pathItem).content?.trim();
  return content ? [content, ""] : [];
};

const renderRequestExample = (
  method: string,
  path: string,
  operation: OpenApiOperation,
  server: string | undefined,
  options: OpenApiGenerationOptions
): string[] =>
  options.examples?.autogenerate === false
    ? []
    : [
        `<RequestExample title=${JSON.stringify(operation.summary ?? "Request")} id="blume-request-example">`,
        "",
        curlRequest(method, path, operation, server),
        "",
        "</RequestExample>",
        "",
      ];

interface JsonExample {
  title: string;
  value: unknown;
}

const mediaExamples = (media: OpenApiMediaType | undefined): JsonExample[] => [
  ...(media?.example === undefined
    ? []
    : [{ title: "Example", value: media.example }]),
  ...Object.entries(media?.examples ?? {}).flatMap(([key, example]) =>
    example.value === undefined
      ? []
      : [{ title: example.summary ?? key, value: example.value }]
  ),
];

const renderResponseExampleContent = (
  responseDescription: string | undefined,
  examples: JsonExample[]
): string[] => {
  if (examples.length === 0) {
    return [responseDescription ?? "No body.", ""];
  }
  if (examples.length === 1) {
    const [example] = examples;
    return example ? [exampleBlock(example.value), ""] : [];
  }
  return examples.flatMap((example) => [
    `### ${example.title}`,
    "",
    exampleBlock(example.value),
    "",
  ]);
};

const renderResponses = (
  operation: OpenApiOperation,
  options: OpenApiGenerationOptions,
  doc: OpenApiDocument
): string[] => {
  const lines: string[] = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const label = `${status}${response.description ? ` — ${response.description}` : ""}`;
    const media = response.content?.[jsonMime];
    const examples = mediaExamples(media);
    const schemaRows = schemaToParameters(media?.schema, options, doc);
    lines.push(
      `<ResponseExample title=${JSON.stringify(label)}>`,
      "",
      ...renderResponseExampleContent(response.description, examples),
      "</ResponseExample>",
      ""
    );
    lines.push(...paramTable(`Response ${status} body`, schemaRows));
  }
  return lines;
};

const renderCallbackOperation = (
  name: string,
  expression: string,
  method: HttpMethod,
  operation: OpenApiOperation,
  doc: OpenApiDocument,
  options: OpenApiGenerationOptions
): string[] => [
  `#### ${name}`,
  "",
  `<Endpoint method=${JSON.stringify(method.toUpperCase())} path={${JSON.stringify(expression)}} tryIt={false} />`,
  "",
  ...renderRequestBody(operation, options, doc),
  ...renderResponses(operation, options, doc),
];

const renderCallbacks = (
  operation: OpenApiOperation,
  options: OpenApiGenerationOptions,
  doc: OpenApiDocument
): string[] => {
  const callbacks = Object.entries(operation.callbacks ?? {});
  if (callbacks.length === 0) {
    return [];
  }
  return [
    "## Callbacks",
    "",
    ...callbacks.flatMap(([name, callback]) =>
      Object.entries(callback).flatMap(([expression, pathItem]) =>
        HTTP_METHODS.flatMap((method) => {
          const callbackOperation = pathItem[method];
          return callbackOperation
            ? renderCallbackOperation(
                name,
                expression,
                method,
                callbackOperation,
                doc,
                options
              )
            : [];
        })
      )
    ),
  ];
};

const normalizedOperationPath = (path: string): string => {
  const trimmed = path.replaceAll(/\/+$/gu, "");
  return trimmed.length > 0 ? trimmed : "/";
};

const operationForReference = (
  doc: OpenApiDocument,
  method: string,
  path: string
):
  | {
      method: HttpMethod;
      operation: OpenApiOperation;
      path: string;
      pathItem: OpenApiPathItem;
    }
  | undefined => {
  const normalizedMethod = method.toLowerCase();
  if (normalizedMethod === "webhook") {
    const pathItem = doc.webhooks?.[path];
    if (!pathItem) {
      return undefined;
    }
    const webhookMethod = HTTP_METHODS.find((candidate) => pathItem[candidate]);
    const operation = webhookMethod ? pathItem[webhookMethod] : undefined;
    return operation && webhookMethod && !isOperationExcluded(operation)
      ? {
          method: webhookMethod,
          operation,
          path,
          pathItem,
        }
      : undefined;
  }
  if (!HTTP_METHODS.includes(normalizedMethod as HttpMethod)) {
    return undefined;
  }
  const entry = Object.entries(doc.paths ?? {}).find(
    ([candidate]) =>
      normalizedOperationPath(candidate) === normalizedOperationPath(path)
  );
  if (!entry) {
    return undefined;
  }
  const [matchedPath, pathItem] = entry;
  const operation = pathItem[normalizedMethod as HttpMethod];
  return operation && !isOperationExcluded(operation)
    ? {
        method: normalizedMethod as HttpMethod,
        operation,
        path: matchedPath,
        pathItem,
      }
    : undefined;
};

export const renderOpenApiOperationContent = (
  doc: OpenApiDocument,
  method: string,
  path: string,
  options: OpenApiGenerationOptions = {}
): string | undefined => {
  const match = operationForReference(doc, method, path);
  if (!match) {
    return undefined;
  }
  const renderOptions: OpenApiGenerationOptions =
    method.toLowerCase() === "webhook"
      ? {
          ...options,
          examples: { ...options.examples, autogenerate: false },
        }
      : options;
  const server = firstServerUrl(match.operation, match.pathItem, doc);
  const display = operationDisplay(
    match.method,
    match.path,
    match.operation,
    match.pathItem,
    server,
    renderOptions
  );
  const lines = [
    ...renderEndpoint(display.endpointProps, display.description),
    ...renderMintlifyContent(match.operation, match.pathItem),
    ...renderParameters(match.operation, renderOptions),
    ...renderRequestBody(match.operation, renderOptions, doc),
    ...renderCallbacks(match.operation, renderOptions, doc),
    ...renderRequestExample(
      match.method,
      match.path,
      match.operation,
      server,
      renderOptions
    ),
    ...renderResponses(match.operation, renderOptions, doc),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};

const renderOperation = (
  method: string,
  path: string,
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem | undefined,
  doc: OpenApiDocument,
  options: OpenApiGenerationOptions
): string => {
  const server = firstServerUrl(operation, pathItem, doc);
  const lines = [
    ...renderFrontmatter(method, path, operation, pathItem, server, options),
    ...renderMintlifyContent(operation, pathItem),
    ...renderParameters(operation, options),
    ...renderRequestBody(operation, options, doc),
    ...renderCallbacks(operation, options, doc),
    ...renderRequestExample(method, path, operation, server, options),
    ...renderResponses(operation, options, doc),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};

const MD_EXTENSION = /\.(?:mdx?|mdoc)$/u;

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const hrefOutputPath = (root: string, href: string): string => {
  const normalized = href
    .replace(MD_EXTENSION, "")
    .replaceAll(/^\/+|\/+$/gu, "");
  const target = normalized.length > 0 ? `${normalized}.mdx` : "index.mdx";
  const absolute = resolve(root, target);
  if (!isInsideRoot(root, absolute)) {
    throw new Error(
      `OpenAPI x-mint.href points outside the output root: ${href}`
    );
  }
  return absolute;
};

const operationOutputPath = (
  outDir: string,
  options: OpenApiGenerationOptions,
  page: OpenApiOperationPage,
  pathItem: OpenApiPathItem | undefined
): string => {
  const href = operationHref(page.operation, pathItem);
  return href
    ? hrefOutputPath(options.rootDir ?? outDir, href)
    : join(outDir, page.group?.slug ?? "", `${page.slug}.mdx`);
};

const renderIndex = (doc: OpenApiDocument): string => {
  const title = doc.info?.title ?? "API Reference";
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (doc.info?.description) {
    lines.push(`description: ${JSON.stringify(doc.info.description)}`);
  }
  lines.push("sidebar:", "  order: 0", "---", "", `# ${title}`, "");
  if (doc.info?.description) {
    lines.push(doc.info.description, "");
  }
  return `${lines.join("\n")}\n`;
};

/** Parse a spec file (JSON or YAML) into an OpenAPI document. */
export const parseOpenApi = async (
  specPath: string
): Promise<OpenApiDocument> => {
  const response =
    specPath.startsWith("http://") || specPath.startsWith("https://")
      ? await fetch(specPath)
      : null;
  if (response && !response.ok) {
    throw new Error(
      `Failed to fetch OpenAPI spec ${specPath}: ${response.status} ${response.statusText}`
    );
  }

  const raw = response
    ? await response.text()
    : await readFile(specPath, "utf-8");
  const contentType = response?.headers.get("content-type") ?? "";
  const data =
    specPath.endsWith(".json") || contentType.includes("json")
      ? JSON.parse(raw)
      : parseYaml(raw);
  return data as OpenApiDocument;
};

/**
 * Generate one MDX page per OpenAPI operation (plus an index) into `outDir`.
 * Returns the list of written file paths.
 */
export const generateApiDocs = async (
  doc: OpenApiDocument,
  outDir: string,
  options: OpenApiGenerationOptions = {}
): Promise<string[]> => {
  await mkdir(outDir, { recursive: true });

  const writes: { path: string; content: string }[] = [
    { content: renderIndex(doc), path: join(outDir, "index.mdx") },
  ];

  for (const page of listOpenApiOperations(doc)) {
    const { method, operation, path } = page;
    const pathItem = doc.paths?.[path];
    writes.push({
      content: renderOperation(method, path, operation, pathItem, doc, options),
      path: operationOutputPath(outDir, options, page, pathItem),
    });
  }

  await Promise.all(
    writes.map(async (write) => {
      await mkdir(dirname(write.path), { recursive: true });
      await writeFile(write.path, write.content, "utf-8");
    })
  );

  return writes.map((write) => write.path);
};
