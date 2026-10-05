import type { OperationObject } from "@scalar/openapi-types/3.2";

import type { ApiDocument } from "./model.ts";
import { HTTP_METHODS } from "./model.ts";

/**
 * Targeted checks for spec mistakes that would otherwise render silently
 * wrong. This is not a validator — a linter such as Spectral or oasdiff owns
 * that — and a spec that fails one of these still renders. Each check names
 * one mistake whose symptom on the page is quiet: a path placeholder sent
 * as literal text, a Try it input whose value goes nowhere, an Authorization
 * section with no scheme to describe. Each reports a warning with its own
 * code, so a build says what's wrong instead of shipping it.
 */

/** One mistake a check found, before the source names the spec it's in. */
export interface SpecIssue {
  code: string;
  message: string;
  suggestion: string;
}

/** A `{name}` placeholder in a path template. */
const PATH_TEMPLATE = /\{(?<name>[^{}]+)\}/gu;

/** A reference to a parameter declared under `components.parameters`. */
const PARAMETER_REF = /^#\/components\/parameters\/(?<name>[^/]+)$/u;

/** How many operations a security-scheme warning names before counting the rest. */
const NAMED_OPERATIONS = 3;

/** One entry of a document's `paths` or `webhooks` map. */
type PathItem = NonNullable<ApiDocument["paths"]>[string];

/**
 * How a warning names an operation: `GET /pets`, or a webhook by its name
 * (`Webhook "newPet" (POST)`), since a webhook has no path.
 */
export const operationLabel = (
  name: string,
  method: string,
  webhook: boolean
): string =>
  webhook
    ? `Webhook "${name}" (${method.toUpperCase()})`
    : `${method.toUpperCase()} ${name}`;

/** One entry of a `parameters` list: a parameter, or a `$ref` to one. */
type ParameterEntry = NonNullable<OperationObject["parameters"]>[number];

// The runtime object checks stand guard because the document was parsed from
// arbitrary YAML/JSON: a spec can put a scalar or null where the type
// promises an object.
const isObject = <Value>(value: Value): value is NonNullable<Value> =>
  typeof value === "object" && value !== null;

/** A parameter's `name`, which a hand-written spec may have left out or mistyped. */
const isName = <Value>(value: Value): value is Value & string =>
  typeof value === "string";

/** A declared list, or none when a hand-written spec put something else there. */
const listOf = <Item>(value: Item[] | undefined): NonNullable<Item>[] =>
  Array.isArray(value) ? value.filter(isObject) : [];

/** A resolved parameter: one that isn't a `$ref`. */
type Parameter = Extract<ParameterEntry, { in: string }>;

/**
 * The parameters an operation declares, its path item's and its own, `$ref`s
 * resolved through `components.parameters`. One that doesn't resolve is left
 * out, as the page leaves it out.
 */
const parametersOf = (
  document: ApiDocument,
  item: PathItem,
  operation: OperationObject
): Parameter[] => {
  const components = document.components?.parameters ?? {};
  return [
    ...listOf<ParameterEntry>(item.parameters),
    ...listOf<ParameterEntry>(operation.parameters),
  ].flatMap((entry) => {
    const refName =
      "$ref" in entry
        ? PARAMETER_REF.exec(entry.$ref)?.groups?.name
        : undefined;
    const parameter = (refName ? components[refName] : undefined) ?? entry;
    return "in" in parameter ? [parameter] : [];
  });
};

/**
 * A path whose template and declared path parameters disagree. A placeholder
 * with no parameter gets no input in Try it and no row in the table, so
 * requests send it as literal text; a parameter with no placeholder gets an
 * input whose value never reaches the URL.
 */
const pathParameterIssues = (
  signature: string,
  path: string,
  declared: Set<string>
): SpecIssue[] => {
  const used = new Set(
    [...path.matchAll(PATH_TEMPLATE)].map((match) => match.groups?.name ?? "")
  );
  const issues: SpecIssue[] = [];
  for (const name of used) {
    if (!declared.has(name)) {
      issues.push({
        code: "BLUME_OPENAPI_PATH_PARAMETER_MISSING",
        message: `${signature} has {${name}} in its path but declares no "${name}" path parameter, so Try it and the code samples send "{${name}}" as literal text.`,
        suggestion: `Declare "${name}" in the operation's or the path's \`parameters\`, with \`in: path\` and \`required: true\`.`,
      });
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      issues.push({
        code: "BLUME_OPENAPI_PATH_PARAMETER_UNUSED",
        message: `${signature} declares a "${name}" path parameter, but its path has no {${name}}, so the value Try it asks for never reaches the URL.`,
        suggestion: `Add {${name}} to the path, or remove the parameter.`,
      });
    }
  }
  return issues;
};

/** The scheme names a `security` list requires. */
const requiredSchemes = (
  security: ApiDocument["security"] | OperationObject["security"]
): string[] =>
  listOf(security).flatMap((requirement) => Object.keys(requirement));

/**
 * Security schemes a requirement names that `components.securitySchemes`
 * doesn't define: the Authorization section has nothing to describe, and
 * Try it and the code samples send no credential for them. One warning per
 * scheme, naming where it's required: the root `security`, or the first few
 * operations that list it.
 */
const securitySchemeIssues = (
  document: ApiDocument,
  requirers: Map<string, string[]>
): SpecIssue[] => {
  const defined = document.components?.securitySchemes ?? {};
  const root = new Set(requiredSchemes(document.security));
  const issues: SpecIssue[] = [];
  for (const scheme of new Set([...root, ...requirers.keys()])) {
    if (Object.hasOwn(defined, scheme)) {
      continue;
    }
    const operations = requirers.get(scheme) ?? [];
    const more = operations.length - NAMED_OPERATIONS;
    const where = root.has(scheme)
      ? "The spec's root `security` requires"
      : `${operations.slice(0, NAMED_OPERATIONS).join(", ")}${more > 0 ? ` and ${more} more` : ""} ${operations.length === 1 ? "requires" : "require"}`;
    issues.push({
      code: "BLUME_OPENAPI_UNKNOWN_SECURITY_SCHEME",
      message: `${where} the "${scheme}" security scheme, which \`components.securitySchemes\` doesn't define, so the Authorization section can't describe it and requests send no credential for it.`,
      suggestion: `Define "${scheme}" in \`components.securitySchemes\`, or fix the name in \`security\`.`,
    });
  }
  return issues;
};

/**
 * An operation's `in: querystring` parameter (OpenAPI 3.2: the whole query
 * string as one value), which the parameter table, Try it, and the code
 * samples don't handle yet, so it would drop out of all three without a sign.
 */
const querystringIssue = (signature: string): SpecIssue => ({
  code: "BLUME_OPENAPI_UNSUPPORTED",
  message: `${signature} declares an \`in: querystring\` parameter, which OpenAPI 3.2 added and Blume doesn't render yet, so the page has no row or Try it input for it and the code samples leave the query string out.`,
  suggestion:
    "Describe the query string in the operation's `description` until Blume renders `querystring` parameters.",
});

/**
 * A path item's `additionalOperations` (OpenAPI 3.2: methods beyond the ones
 * a path item names directly, like `COPY`), which the extractor doesn't
 * collect yet, so those operations would be missing without a sign.
 */
const additionalOperationsIssue = (
  label: string,
  methods: string[]
): SpecIssue => ({
  code: "BLUME_OPENAPI_UNSUPPORTED",
  message: `${label} declares \`additionalOperations\` (${methods.join(", ")}), which OpenAPI 3.2 added and Blume doesn't render yet, so those operations are missing from the reference.`,
  suggestion:
    "Document those operations on a page of their own until Blume renders `additionalOperations`.",
});

/**
 * A root `x-webhooks` and no `webhooks`. It's the extension OpenAPI 3.0 tools
 * read for webhooks, and upgrading a 3.0 spec renames it to `webhooks`; a spec
 * already at 3.1 or later isn't upgraded, so it stays an extension and its
 * webhooks would be missing without a sign.
 */
const xWebhooksIssues = (document: ApiDocument): SpecIssue[] =>
  "x-webhooks" in document && document.webhooks === undefined
    ? [
        {
          code: "BLUME_OPENAPI_X_WEBHOOKS",
          message:
            "The spec declares its webhooks under `x-webhooks`, the extension OpenAPI 3.0 tools read. Blume reads it only from a 3.0 spec, which it upgrades, so these webhooks are missing from the reference.",
          suggestion:
            "Rename `x-webhooks` to `webhooks`, the field OpenAPI 3.1 added for them.",
        },
      ]
    : [];

/**
 * Check a parsed document for the mistakes above, and for the OpenAPI 3.2
 * features Blume doesn't render yet. `$ref` path items are skipped: the
 * extractor already reports them as missing from the reference.
 */
export const specIssues = (document: ApiDocument): SpecIssue[] => {
  const issues: SpecIssue[] = [...xWebhooksIssues(document)];
  // Scheme name -> the operations whose own `security` lists it.
  const requirers = new Map<string, string[]>();
  const visit = (name: string, item: PathItem, webhook: boolean): void => {
    if (!isObject(item) || "$ref" in item) {
      return;
    }
    const additional = isObject(item.additionalOperations)
      ? Object.keys(item.additionalOperations)
      : [];
    if (additional.length > 0) {
      issues.push(
        additionalOperationsIssue(
          webhook ? `Webhook "${name}"` : `Path "${name}"`,
          additional
        )
      );
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isObject(operation)) {
        continue;
      }
      const signature = operationLabel(name, method, webhook);
      for (const scheme of requiredSchemes(operation.security)) {
        requirers.set(scheme, [...(requirers.get(scheme) ?? []), signature]);
      }
      const parameters = parametersOf(document, item, operation);
      // A webhook is keyed by its name, not a path: it has no template.
      if (!webhook) {
        issues.push(
          ...pathParameterIssues(
            signature,
            name,
            new Set(
              parameters
                .filter((parameter) => parameter.in === "path")
                .map((parameter) => parameter.name)
                .filter(isName)
            )
          )
        );
      }
      if (parameters.some((parameter) => parameter.in === "querystring")) {
        issues.push(querystringIssue(signature));
      }
    }
  };
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    visit(path, item, false);
  }
  for (const [name, item] of Object.entries(document.webhooks ?? {})) {
    visit(name, item, true);
  }
  return [...issues, ...securitySchemeIssues(document, requirers)];
};
