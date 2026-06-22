import { mkdir, readFile, writeFile } from "node:fs/promises";

import { dirname, join } from "pathe";
import { parse as parseYaml } from "yaml";

import { HTTP_METHODS } from "./types.ts";
import type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
} from "./types.ts";

const NON_SLUG = /[^a-z0-9]+/gu;

const slugify = (value: string): string =>
  value.toLowerCase().replace(NON_SLUG, "-").replaceAll(/^-|-$/gu, "");

const operationSlug = (
  method: string,
  path: string,
  operation: OpenApiOperation
): string =>
  operation.operationId
    ? slugify(operation.operationId)
    : slugify(`${method}-${path}`);

/** Flatten a JSON schema's properties into displayable parameter rows. */
const schemaToParameters = (schema: OpenApiSchema | undefined) => {
  if (!schema?.properties) {
    return [];
  }
  const required = new Set(schema.required);
  return Object.entries(schema.properties).map(([name, prop]) => ({
    description: prop.description,
    name,
    required: required.has(name),
    type: prop.type ?? "object",
  }));
};

const paramsToRows = (parameters: OpenApiParameter[]) =>
  parameters.map((parameter) => ({
    description: parameter.description,
    name: parameter.name,
    required: parameter.required ?? false,
    type: parameter.schema?.type ?? "string",
  }));

const exampleBlock = (value: unknown): string =>
  ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

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

const renderFrontmatter = (
  method: string,
  path: string,
  operation: OpenApiOperation
): string[] => {
  const upper = method.toUpperCase();
  const title = operation.summary ?? `${upper} ${path}`;
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (operation.description) {
    lines.push(`description: ${JSON.stringify(operation.description)}`);
  }
  lines.push(
    "type: api",
    "api:",
    `  method: ${upper}`,
    `  path: ${JSON.stringify(path)}`,
    "---",
    "",
    `# ${title}`,
    "",
    `<Endpoint method=${JSON.stringify(upper)} path={${JSON.stringify(path)}} />`,
    ""
  );
  if (operation.description) {
    lines.push(operation.description, "");
  }
  return lines;
};

const renderParameters = (operation: OpenApiOperation): string[] => {
  const params = operation.parameters ?? [];
  return [
    ...paramTable(
      "Path parameters",
      paramsToRows(params.filter((p) => p.in === "path"))
    ),
    ...paramTable(
      "Query parameters",
      paramsToRows(params.filter((p) => p.in === "query"))
    ),
  ];
};

const renderRequestBody = (operation: OpenApiOperation): string[] => {
  const media = operation.requestBody?.content?.["application/json"];
  const lines = paramTable("Body", schemaToParameters(media?.schema));
  const example = media?.example ?? media?.schema?.example;
  if (example !== undefined) {
    lines.push(
      "<RequestExample>",
      "",
      exampleBlock(example),
      "",
      "</RequestExample>",
      ""
    );
  }
  return lines;
};

const renderResponses = (operation: OpenApiOperation): string[] => {
  const lines: string[] = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const label = `${status}${response.description ? ` — ${response.description}` : ""}`;
    const example = response.content?.["application/json"]?.example;
    lines.push(
      `<ResponseExample title=${JSON.stringify(label)}>`,
      "",
      ...(example === undefined
        ? [response.description ?? "No body.", ""]
        : [exampleBlock(example), ""]),
      "</ResponseExample>",
      ""
    );
  }
  return lines;
};

const renderOperation = (
  method: string,
  path: string,
  operation: OpenApiOperation
): string => {
  const lines = [
    ...renderFrontmatter(method, path, operation),
    ...renderParameters(operation),
    ...renderRequestBody(operation),
    ...renderResponses(operation),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
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
  const raw = await readFile(specPath, "utf-8");
  const data = specPath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return data as OpenApiDocument;
};

/**
 * Generate one MDX page per OpenAPI operation (plus an index) into `outDir`.
 * Returns the list of written file paths.
 */
export const generateApiDocs = async (
  doc: OpenApiDocument,
  outDir: string
): Promise<string[]> => {
  await mkdir(outDir, { recursive: true });

  const writes: { path: string; content: string }[] = [
    { content: renderIndex(doc), path: join(outDir, "index.mdx") },
  ];

  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = methods[method];
      if (!operation) {
        continue;
      }
      const slug = operationSlug(method, path, operation);
      writes.push({
        content: renderOperation(method, path, operation),
        path: join(outDir, `${slug}.mdx`),
      });
    }
  }

  await Promise.all(
    writes.map(async (write) => {
      await mkdir(dirname(write.path), { recursive: true });
      await writeFile(write.path, write.content, "utf-8");
    })
  );

  return writes.map((write) => write.path);
};
