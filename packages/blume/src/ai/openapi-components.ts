import { mountBasePath, normalizeBasePath } from "../core/base-path.ts";
import type { ApiOperationRef, OpenApiData } from "../openapi/model.ts";
import { operationOf, specAddresses, specOf } from "../openapi/model.ts";
import { asSentence } from "../openapi/sentence.ts";
import { operationSignature } from "../openapi/signature.ts";
import type {
  ComponentMarkdown,
  EvaluatedValue,
} from "./component-markdown.ts";
import { inlineCode, isString, linkDestination } from "./component-markdown.ts";

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
 * served URL: its route under the deployment base.
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
  return `- [${inlineCode(signature)}](${linkDestination(href)})${tail ? ` — ${tail}` : ""}`;
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
 * section shows. Parameters, schemas and responses are deliberately left out:
 * those are `operation-model.ts` plus each component's own preparation, and a
 * second implementation here would be free to disagree with the page. The
 * endpoint and what it does is the part that was missing altogether.
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
      return operation.deprecated
        ? `${signature}\n\n**Deprecated.**`
        : signature;
    },
  } satisfies Record<string, ComponentMarkdown>;
};
