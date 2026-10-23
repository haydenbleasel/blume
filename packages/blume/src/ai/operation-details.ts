import {
  preferredMedia,
  responsePanels,
} from "../components/openapi/example-panels.ts";
import type { ResponseLike } from "../components/openapi/example-panels.ts";
import {
  isNullable,
  mediaExample,
  namedExamples,
  objectProperties,
  resolveComponentRef,
  resolveSchema,
  toJson,
  typeLabel,
} from "../components/openapi/helpers.ts";
import type {
  ComponentsLike,
  ExampleDirection,
  MediaLike,
  SchemaLike,
  SpecValue,
} from "../components/openapi/helpers.ts";
import type { ApiDocument } from "../openapi/model.ts";
import { fencedBlock, inlineCode } from "./component-markdown.ts";

/**
 * The body and responses of an OpenAPI operation as compact Markdown, for the
 * agent-facing copy of its page (`<route>.md`, llms-full.txt, MCP
 * `get_page`): the request body's media type and top-level properties, its
 * example (every named one), each response's status and description, and
 * the examples the spec records. Without these an agent read an endpoint
 * with no word of what to send or what comes back, though the spec, and the
 * page, had both. Built from the helpers the page's own components use, so
 * the two can't disagree: the same JSON-ish media type, the same examples,
 * `readOnly` and `writeOnly` properties left out the same way.
 *
 * Kept compact: properties one level deep (an example shows the rest), and
 * a sampled response example only for the first success response that
 * records none, since error bodies often all share one schema.
 */

/** A request body, `$ref` resolved. */
interface RequestBodyLike {
  description?: string;
  required?: boolean;
  content?: Record<string, MediaLike>;
}

/** The operation fields read here. */
export interface OperationParts {
  requestBody?: RequestBodyLike & { $ref?: string };
  responses?: Record<string, ResponseLike & { $ref?: string }>;
}

/** Spec prose on one line, the characters Markdown reads as markup escaped. */
const oneLine = (text: string): string =>
  text
    .trim()
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/[\\`*_[\]<>~]/gu, String.raw`\$&`);

/** A fenced JSON example, under its label. */
const exampleBlock = (label: string, value: SpecValue): string =>
  `${label}:\n\n${fencedBlock("json", toJson(value))}`;

/** One line per top-level property: name, type, required, description. */
const propertyLines = (
  schema: SchemaLike | undefined,
  schemas: Record<string, SchemaLike>,
  direction: ExampleDirection
): string[] => {
  if (!schema) {
    return [];
  }
  const omitted = direction === "request" ? "readOnly" : "writeOnly";
  const { properties, required } = objectProperties(schema, schemas);
  return properties.flatMap(([name, property]) => {
    const resolved = resolveSchema(schemas, property);
    if (property[omitted] === true || resolved[omitted] === true) {
      return [];
    }
    const type = `${typeLabel(property)}${isNullable(resolved) ? " | null" : ""}`;
    const notes = [type, required.has(name) ? "required" : ""]
      .filter(Boolean)
      .join(", ");
    const description = resolved.description?.trim();
    return [
      `- ${inlineCode(name)} (${notes})${description ? ` — ${oneLine(description)}` : ""}`,
    ];
  });
};

/** The request body (a webhook's payload): media type, properties, examples. */
const bodyMarkdown = (
  body: RequestBodyLike,
  schemas: Record<string, SchemaLike>,
  components: ComponentsLike | undefined,
  webhook: boolean
): string[] => {
  const chosen = preferredMedia(body.content);
  if (!chosen) {
    return [];
  }
  const [type, media] = chosen;
  // A webhook's payload travels from the API, like a response.
  const direction = webhook ? "response" : "request";
  const heading = webhook ? "Payload" : "Request body";
  const lines = propertyLines(media.schema, schemas, direction);
  const named = namedExamples(media, schemas, direction, components);
  const single = mediaExample(media, schemas, direction, components);
  const examples =
    named.length > 0
      ? named.map((example) =>
          exampleBlock(
            `${heading} example, ${oneLine(example.label)}`,
            example.value
          )
        )
      : [
          single === null || single === undefined
            ? ""
            : exampleBlock(`${heading} example`, single),
        ];
  return [
    `**${heading}** (${[inlineCode(type), body.required ? "required" : ""].filter(Boolean).join(", ")})`,
    body.description?.trim() ? oneLine(body.description) : "",
    lines.join("\n"),
    ...examples,
  ].filter(Boolean);
};

/** The responses: one line per status, then the examples the spec records. */
const responsesMarkdown = (
  responses: Record<string, ResponseLike>,
  schemas: Record<string, SchemaLike>,
  components: ComponentsLike | undefined
): string[] => {
  const statuses = Object.entries(responses);
  if (statuses.length === 0) {
    return [];
  }
  const recorded = new Set(
    statuses.flatMap(([status, response]) => {
      const media = preferredMedia(response.content)?.[1];
      return media?.example === undefined && media?.examples === undefined
        ? []
        : [status];
    })
  );
  const sampled = statuses.find(
    ([status]) => status.startsWith("2") && !recorded.has(status)
  )?.[0];
  // Only panels that carry an example are written, so no empty text shows.
  const examples = responsePanels(responses, schemas, "", components).flatMap(
    (panel) =>
      (recorded.has(panel.name) || panel.name === sampled) &&
      panel.value !== null &&
      panel.value !== undefined
        ? [
            exampleBlock(
              `Response example, ${oneLine(panel.label)}`,
              panel.value
            ),
          ]
        : []
  );
  return [
    "**Responses**",
    statuses
      .map(
        ([status, response]) =>
          `- ${inlineCode(status)}${response.description?.trim() ? ` — ${oneLine(response.description)}` : ""}`
      )
      .join("\n"),
    ...examples,
  ];
};

/**
 * An operation's body and responses as Markdown blocks, `$ref`s to
 * `components` resolved, ready to join with blank lines.
 */
export const operationDetails = (
  document: ApiDocument,
  operation: OperationParts,
  webhook: boolean
): string[] => {
  // SAFETY: a parsed document's `components` is the section-keyed table
  // `ComponentsLike` describes; the helpers guard every entry they read.
  const components = document.components as ComponentsLike | undefined;
  // SAFETY: component schemas are the JSON Schema objects `SchemaLike` views.
  const schemas = (document.components?.schemas ?? {}) as Record<
    string,
    SchemaLike
  >;
  const body = operation.requestBody
    ? resolveComponentRef(operation.requestBody, components, "requestBodies")
    : undefined;
  const responses = Object.fromEntries(
    Object.entries(operation.responses ?? {}).map(([status, response]) => [
      status,
      resolveComponentRef(response, components, "responses"),
    ])
  );
  return [
    ...(body ? bodyMarkdown(body, schemas, components, webhook) : []),
    ...responsesMarkdown(responses, schemas, components),
  ];
};
