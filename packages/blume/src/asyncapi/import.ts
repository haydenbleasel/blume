import { mkdir, readFile, writeFile } from "node:fs/promises";

import { dirname, join } from "pathe";
import { parse as parseYaml } from "yaml";

import type {
  AsyncApiChannel,
  AsyncApiDocument,
  AsyncApiMessage,
  AsyncApiOperation,
  AsyncApiReference,
  AsyncApiSchema,
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

const decodePointerSegment = (value: string): string =>
  value.replaceAll("~1", "/").replaceAll("~0", "~");

const isReference = (value: unknown): value is AsyncApiReference =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as AsyncApiReference).$ref === "string";

const refName = (value: AsyncApiReference): string | undefined =>
  value.$ref.split("/").at(-1);

const localRefValue = (doc: AsyncApiDocument, ref: string): unknown => {
  if (!ref.startsWith("#/")) {
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

const resolveLocal = <T>(
  doc: AsyncApiDocument,
  value: T | AsyncApiReference | undefined
): T | undefined =>
  isReference(value)
    ? (localRefValue(doc, value.$ref) as T | undefined)
    : value;

const channelIdFromRef = (
  value: AsyncApiReference | undefined
): string | undefined =>
  value?.$ref.startsWith("#/channels/")
    ? decodePointerSegment(value.$ref.slice("#/channels/".length))
    : undefined;

const operationValues = (
  value: AsyncApiOperation["messages"]
): (AsyncApiMessage | AsyncApiReference)[] =>
  Array.isArray(value) ? value : Object.values(value ?? {});

const channelTitle = (id: string, channel: AsyncApiChannel): string =>
  channel.title ?? channel.address ?? id;

const channelSlug = (id: string, channel: AsyncApiChannel): string =>
  slugify(channel.title ?? id) || slugify(channel.address ?? id);

export const channelPageSlug = (id: string, channel: AsyncApiChannel): string =>
  channelSlug(id, channel);

const operationChannelId = (
  doc: AsyncApiDocument,
  operation: AsyncApiOperation
): string | undefined => {
  if (isReference(operation.channel)) {
    return channelIdFromRef(operation.channel);
  }

  const channel = resolveLocal<AsyncApiChannel>(doc, operation.channel);
  if (!channel) {
    return undefined;
  }

  return Object.entries(doc.channels ?? {}).find(([, item]) => {
    const candidate = resolveLocal<AsyncApiChannel>(doc, item);
    return candidate === channel || candidate?.address === channel.address;
  })?.[0];
};

const messageWithFallbackName = (
  message: AsyncApiMessage,
  fallback: string | undefined
): AsyncApiMessage =>
  message.name || !fallback ? message : { ...message, name: fallback };

const resolveMessage = (
  doc: AsyncApiDocument,
  value: AsyncApiMessage | AsyncApiReference | undefined,
  fallbackName?: string
): AsyncApiMessage | undefined => {
  const message = resolveLocal<AsyncApiMessage>(doc, value);
  if (!message) {
    return undefined;
  }
  return messageWithFallbackName(
    message,
    fallbackName ?? (isReference(value) ? refName(value) : undefined)
  );
};

const resolveOperation = (
  doc: AsyncApiDocument,
  value: AsyncApiOperation | AsyncApiReference | undefined,
  fallbackAction?: string
): AsyncApiOperation | undefined => {
  const operation = resolveLocal<AsyncApiOperation>(doc, value);
  if (!operation) {
    return undefined;
  }
  return operation.action || !fallbackAction
    ? operation
    : { ...operation, action: fallbackAction };
};

const channelOperations = (
  doc: AsyncApiDocument,
  channelId: string,
  channel: AsyncApiChannel
): AsyncApiOperation[] => {
  const operations: AsyncApiOperation[] = [];
  const publish = resolveOperation(doc, channel.publish, "send");
  const subscribe = resolveOperation(doc, channel.subscribe, "receive");
  if (publish) {
    operations.push(publish);
  }
  if (subscribe) {
    operations.push(subscribe);
  }

  for (const operation of Object.values(doc.operations ?? {})) {
    const resolved = resolveOperation(doc, operation);
    if (resolved && operationChannelId(doc, resolved) === channelId) {
      operations.push(resolved);
    }
  }
  return operations;
};

const channelMessages = (
  doc: AsyncApiDocument,
  channel: AsyncApiChannel,
  operations: AsyncApiOperation[]
): AsyncApiMessage[] => {
  const messages: AsyncApiMessage[] = [];
  const seen = new Set<string>();
  const add = (
    value: AsyncApiMessage | AsyncApiReference | undefined,
    fallbackName?: string
  ) => {
    const message = resolveMessage(doc, value, fallbackName);
    if (!message) {
      return;
    }
    const key =
      message.name ??
      message.title ??
      message.summary ??
      JSON.stringify(message.payload ?? {});
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    messages.push(message);
  };

  for (const [key, message] of Object.entries(channel.messages ?? {})) {
    add(message, key);
  }
  for (const operation of operations) {
    for (const message of operationValues(operation.messages)) {
      add(message, isReference(message) ? refName(message) : undefined);
    }
  }
  return messages;
};

export interface AsyncApiChannelPage {
  id: string;
  slug: string;
  channel: AsyncApiChannel;
  operations: AsyncApiOperation[];
  messages: AsyncApiMessage[];
}

interface SchemaRow {
  description?: string;
  name: string;
  required: boolean;
  type?: string;
}

export const listAsyncApiChannels = (
  doc: AsyncApiDocument
): AsyncApiChannelPage[] =>
  Object.entries(doc.channels ?? {}).flatMap(([id, value]) => {
    const channel = resolveLocal<AsyncApiChannel>(doc, value);
    if (!channel) {
      return [];
    }
    const operations = channelOperations(doc, id, channel);
    return [
      {
        channel,
        id,
        messages: channelMessages(doc, channel, operations),
        operations,
        slug: channelSlug(id, channel),
      },
    ];
  });

const displayType = (
  doc: AsyncApiDocument,
  schema: AsyncApiSchema | AsyncApiReference | undefined,
  seen = new Set<string>()
): string | undefined => {
  if (isReference(schema)) {
    if (seen.has(schema.$ref)) {
      return refName(schema);
    }
    seen.add(schema.$ref);
  }
  const resolved = resolveLocal<AsyncApiSchema>(doc, schema);
  if (!resolved) {
    return undefined;
  }
  const { type } = resolved;
  const isArray =
    type === "array" ||
    (Array.isArray(type) && type.includes("array")) ||
    Boolean(resolved.items);
  if (isArray) {
    return `${displayType(doc, resolved.items, new Set(seen)) ?? "object"}[]`;
  }
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  if (type) {
    return type;
  }
  if (resolved.oneOf) {
    return "oneOf";
  }
  if (resolved.anyOf) {
    return "anyOf";
  }
  if (resolved.allOf) {
    return "object";
  }
  if (resolved.properties) {
    return "object";
  }
  return isReference(schema) ? refName(schema) : undefined;
};

const schemaTitle = (
  doc: AsyncApiDocument,
  schema: AsyncApiSchema | AsyncApiReference,
  fallback: string
): string => {
  const resolved = resolveLocal<AsyncApiSchema>(doc, schema);
  return (
    resolved?.title ??
    (isReference(schema) ? refName(schema) : undefined) ??
    fallback
  );
};

const joinSchemaPath = (prefix: string | undefined, name: string): string =>
  prefix ? `${prefix}.${name}` : name;

const isArraySchema = (schema: AsyncApiSchema | undefined): boolean => {
  const type = schema?.type;
  return (
    type === "array" ||
    (Array.isArray(type) && type.includes("array")) ||
    Boolean(schema?.items)
  );
};

const schemaRows = (
  doc: AsyncApiDocument,
  schema: AsyncApiSchema | AsyncApiReference | undefined,
  prefix?: string,
  seen = new Set<string>()
): SchemaRow[] => {
  if (isReference(schema)) {
    if (seen.has(schema.$ref)) {
      return [];
    }
    seen.add(schema.$ref);
  }
  const resolved = resolveLocal<AsyncApiSchema>(doc, schema);
  if (!resolved) {
    return [];
  }

  const requiredFields = new Set(resolved.required);
  const propertyRows = (
    name: string,
    property: AsyncApiSchema | AsyncApiReference,
    isRequired: boolean
  ): SchemaRow[] => {
    const branchSeen = new Set(seen);
    const prop = resolveLocal<AsyncApiSchema>(doc, property);
    const rowName = joinSchemaPath(prefix, name);
    const arraySchema = isArraySchema(prop);
    const childPrefix = arraySchema ? `${rowName}[]` : rowName;
    const childSchema = arraySchema ? prop?.items : prop;
    return [
      {
        description: prop?.description,
        name: rowName,
        required: isRequired,
        type: displayType(doc, property, branchSeen),
      },
      ...schemaRows(doc, childSchema, childPrefix, branchSeen),
    ];
  };

  const ownRows = Object.entries(resolved.properties ?? {}).flatMap(
    ([name, property]) => propertyRows(name, property, requiredFields.has(name))
  );

  return [
    ...ownRows,
    ...(resolved.allOf ?? []).flatMap((item) =>
      schemaRows(doc, item, prefix, new Set(seen))
    ),
    ...(resolved.oneOf ?? resolved.anyOf ?? []).flatMap((item, index) =>
      schemaRows(
        doc,
        item,
        joinSchemaPath(prefix, schemaTitle(doc, item, `option${index + 1}`)),
        new Set(seen)
      )
    ),
  ];
};

const prop = (name: string, value: unknown): string | undefined =>
  value === undefined ? undefined : `${name}={${JSON.stringify(value)}}`;

const responseField = (row: SchemaRow): string[] => [
  `<ResponseField ${[
    prop("name", row.name),
    prop("type", row.type),
    row.required ? "required={true}" : undefined,
  ]
    .filter(Boolean)
    .join(" ")}>`,
  "",
  row.description ?? "No description.",
  "",
  "</ResponseField>",
  "",
];

const exampleBlock = (value: unknown): string =>
  ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

const schemaExample = (
  schema: AsyncApiSchema | AsyncApiReference | undefined,
  doc: AsyncApiDocument
): unknown => {
  const resolved = resolveLocal<AsyncApiSchema>(doc, schema);
  return resolved?.example ?? resolved?.examples?.[0];
};

const renderFrontmatter = (
  title: string,
  description: string | undefined
): string[] => {
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (description) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }
  lines.push("---", "");
  return lines;
};

const renderIndex = (doc: AsyncApiDocument): string => {
  const title = doc.info?.title ?? "Event Reference";
  const lines = [
    ...renderFrontmatter(title, doc.info?.description),
    `# ${title}`,
    "",
  ];
  if (doc.info?.description) {
    lines.push(doc.info.description, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

const renderOperation = (operation: AsyncApiOperation): string[] => {
  const action = operation.action ? operation.action.toUpperCase() : "EVENT";
  const title = operation.title ?? operation.summary ?? action;
  return [
    `### ${title}`,
    "",
    `\`${action}\``,
    "",
    ...(operation.description ? [operation.description, ""] : []),
  ];
};

const renderMessage = (
  message: AsyncApiMessage,
  doc: AsyncApiDocument
): string[] => {
  const title = message.title ?? message.name ?? message.summary ?? "Message";
  const rows = schemaRows(doc, message.payload);
  const example = schemaExample(message.payload, doc);
  return [
    `### ${title}`,
    "",
    ...(message.summary ? [message.summary, ""] : []),
    ...(message.description ? [message.description, ""] : []),
    ...(rows.length > 0
      ? ["#### Payload", "", ...rows.flatMap(responseField)]
      : []),
    ...(example === undefined ? [] : [exampleBlock(example), ""]),
  ];
};

const renderChannelBody = (
  page: AsyncApiChannelPage,
  doc: AsyncApiDocument,
  options: { includeTitle?: boolean } = {}
): string[] => {
  const title = channelTitle(page.id, page.channel);
  const lines: string[] = [];
  if (options.includeTitle) {
    lines.push(`# ${title}`, "");
  }
  if (page.channel.address) {
    lines.push(`\`${page.channel.address}\``, "");
  }
  if (page.channel.description) {
    lines.push(page.channel.description, "");
  }
  if (page.operations.length > 0) {
    lines.push("## Operations", "");
    lines.push(...page.operations.flatMap(renderOperation));
  }
  if (page.messages.length > 0) {
    lines.push("## Messages", "");
    for (const message of page.messages) {
      lines.push(...renderMessage(message, doc));
    }
  }
  return lines;
};

const renderChannel = (
  page: AsyncApiChannelPage,
  doc: AsyncApiDocument
): string => {
  const title = channelTitle(page.id, page.channel);
  const lines = [
    ...renderFrontmatter(title, page.channel.description),
    ...renderChannelBody(page, doc, { includeTitle: true }),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};

/** Render one AsyncAPI channel body for a manual Mintlify frontmatter page. */
export const renderAsyncApiChannelContent = (
  doc: AsyncApiDocument,
  channelId: string
): string | undefined => {
  const page = listAsyncApiChannels(doc).find(
    (candidate) =>
      candidate.id === channelId ||
      candidate.slug === channelId ||
      candidate.channel.address === channelId
  );
  if (!page) {
    return undefined;
  }
  return `${renderChannelBody(page, doc).join("\n").trimEnd()}\n`;
};

/** Parse a spec file (JSON or YAML) into an AsyncAPI document. */
export const parseAsyncApi = async (
  specPath: string
): Promise<AsyncApiDocument> => {
  const response =
    specPath.startsWith("http://") || specPath.startsWith("https://")
      ? await fetch(specPath)
      : null;
  if (response && !response.ok) {
    throw new Error(
      `Failed to fetch AsyncAPI spec ${specPath}: ${response.status} ${response.statusText}`
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
  return data as AsyncApiDocument;
};

/**
 * Generate one MDX page per AsyncAPI channel (plus an index) into `outDir`.
 * Returns the list of written file paths.
 */
export const generateAsyncApiDocs = async (
  doc: AsyncApiDocument,
  outDir: string
): Promise<string[]> => {
  await mkdir(outDir, { recursive: true });

  const writes: { path: string; content: string }[] = [
    { content: renderIndex(doc), path: join(outDir, "index.mdx") },
    ...listAsyncApiChannels(doc).map((page) => ({
      content: renderChannel(page, doc),
      path: join(outDir, `${page.slug}.mdx`),
    })),
  ];

  await Promise.all(
    writes.map(async (write) => {
      await mkdir(dirname(write.path), { recursive: true });
      await writeFile(write.path, write.content, "utf-8");
    })
  );

  return writes.map((write) => write.path);
};
