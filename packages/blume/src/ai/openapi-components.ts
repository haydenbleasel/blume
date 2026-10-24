import { customCodeSamples } from "../components/openapi/code-samples.ts";
import { mountBasePath, normalizeBasePath } from "../core/base-path.ts";
import type {
  ApiDocument,
  ApiOperationRef,
  OpenApiData,
} from "../openapi/model.ts";
import {
  operationObject,
  operationOf,
  specAddresses,
  specOf,
} from "../openapi/model.ts";
import { asSentence } from "../openapi/sentence.ts";
import { operationSignature } from "../openapi/signature.ts";
import type {
  ComponentMarkdown,
  EvaluatedValue,
} from "./component-markdown.ts";
import { fencedBlock, inlineCode, isString } from "./component-markdown.ts";
import { routeTarget } from "./link-text.ts";
import { operationDetails } from "./operation-details.ts";
import type { OperationParts } from "./operation-details.ts";

/**
 * Spec-authored prose as one line of inline Markdown. Unlike the props the
 * other serializers pass through, a summary is written by whoever wrote the
 * spec, not by the docs author, so the characters CommonMark would read as
 * markup — `<user>` as inline HTML, `*only*` as emphasis — are escaped.
 */
const inlineText = (text: string): string =>
  text
    .trim()
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/[\\`*_[\]<>~]/gu, String.raw`\$&`);

/**
 * One operation as a link, for the tag listings. `href` is the operation's
 * route, under the deployment base unless the assistant reads it, written as
 * every generated page link is (see `routeTarget`).
 */
const listItem = (
  signature: string,
  href: string,
  operation: Pick<ApiOperationRef, "deprecated" | "summary">
): string => {
  const tail = [
    // Title-like summaries ("Get a flag") need their own period before the
    // "Deprecated." that may follow.
    inlineText(asSentence(operation.summary.trim())),
    operation.deprecated ? "Deprecated." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `- [${inlineCode(signature)}](${routeTarget(href)})${tail ? ` — ${tail}` : ""}`;
};

/**
 * Agent-facing Markdown for the components a generated reference page is made
 * of: `<Operation>`, `<ApiTagOperations>` and `<ApiOverview>`.
 *
 * `render-mdx.ts` builds each reference page as the operation's description in
 * the body plus one of these components, deliberately: the structured UI is the
 * component's job, and the prose stays Markdown so it indexes. That split is
 * right for the rendered page and lossy everywhere else — `<route>.md`,
 * llms-full.txt, MCP `get_page` and the assistant corpus all downlevel components
 * to Markdown, and these three had no serializer, so an operation page reached
 * an agent as its description followed by a bare tag. On a site whose reference
 * is most of the corpus, that is most of the corpus: measured on one 449-page
 * site, 266 pages and 266 raw `<Operation>` in llms-full.txt, so "which
 * endpoint do I call?" had no answer anywhere in the agent surface.
 *
 * Each serializer emits what its component renders and no more: the endpoint
 * in the spec kind's own notation ({@link operationSignature}), the version and
 * addresses the overview shows ({@link specAddresses}), the linked list a tag
 * section shows. The spec's own `x-codeSamples` come along, as fenced code:
 * they're text the spec wrote out (often an SDK call no agent could derive
 * from the endpoint), read through the same `customCodeSamples` the page
 * renders. So do an OpenAPI operation's request body and responses, with
 * their examples ({@link operationDetails}), built from the helpers the
 * page's components use so the two can't disagree; parameters and nested
 * schemas are left to the page.
 *
 * `specs` is the parsed `blume:openapi` data — empty when the project has no
 * API reference, in which case every serializer declines. `deployBase` is the
 * configured `deployment.base`: operation routes carry `basePath` but not it,
 * and the links written here are made after the agent surfaces rebase the
 * page's own links, so they take it here, as the rendered page's do.
 */
export const openapiComponentSerializers = (
  specs: OpenApiData,
  deployBase?: string
) => {
  const base = normalizeBasePath(deployBase);
  const spec = (source: EvaluatedValue) =>
    isString(source) ? specOf(specs, source) : undefined;

  return {
    /**
     * The spec-level block at the top of the overview page: its version and
     * where the API lives. The tag sections that follow are real Markdown
     * headings over `<ApiTagOperations>`, so they downlevel on their own.
     */
    ApiOverview: ({ props }) => {
      const data = spec(props.source);
      if (!data) {
        return null;
      }
      const { addresses, label } = specAddresses(data);
      const lines = [
        data.version ? `Version ${inlineText(data.version)}` : "",
        addresses.length > 0
          ? `${label}: ${addresses.map(inlineCode).join(", ")}`
          : "",
      ].filter(Boolean);
      return lines.length > 0 ? lines.join("\n\n") : null;
    },

    /** One tag's operations, mirroring the list the rendered page shows. */
    ApiTagOperations: ({ props }) => {
      const { tag } = props;
      const data = spec(props.source);
      if (!(data && isString(tag))) {
        return null;
      }
      const items = Object.values(data.operations)
        .filter((operation) => operation.tagSlug === tag)
        .map((operation) =>
          listItem(
            operationSignature(data, operation),
            mountBasePath(base, operation.route),
            operation
          )
        );
      return items.length > 0 ? items.join("\n") : null;
    },

    /**
     * One operation. Declines when the spec carries no such key — Blume's own
     * fallback, which leaves the JSX visible rather than publishing a page that
     * silently lost its endpoint.
     */
    Operation: ({ props }) => {
      const { id } = props;
      const data = spec(props.source);
      if (!(data && isString(id))) {
        return null;
      }
      const operation = operationOf(data, id);
      if (!operation) {
        return null;
      }
      const signature = inlineCode(operationSignature(data, operation));
      const notes = [
        // An agent reading the page must not take a webhook for an endpoint
        // it can call.
        operation.webhook
          ? "**Webhook.** The API sends this request to your endpoint."
          : "",
        operation.deprecated ? "**Deprecated.**" : "",
      ].filter(Boolean);
      // The spec's own `x-codeSamples`, labeled as their tabs are.
      const object =
        data.kind === "openapi" ? operationObject(data, operation) : undefined;
      const samples = customCodeSamples({
        "x-code-samples": object?.["x-code-samples"],
        "x-codeSamples": object?.["x-codeSamples"],
      }).map(
        (sample) =>
          `**${inlineText(sample.label)}**\n\n${fencedBlock(sample.lang, sample.source)}`
      );
      // SAFETY: an operation object only resolves out of an OpenAPI spec,
      // whose document is the OpenAPI shape; its bodies and responses are
      // the JSON `OperationParts` views, which the helpers read defensively.
      const details = object
        ? operationDetails(
            data.document as ApiDocument,
            object as OperationParts,
            operation.webhook === true
          )
        : [];
      return [signature, ...notes, ...samples, ...details].join("\n\n");
    },
  } satisfies Record<string, ComponentMarkdown>;
};
