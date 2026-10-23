import { namedExamples, responseExample } from "./helpers.ts";
import type {
  ComponentsLike,
  MediaLike,
  SchemaLike,
  SpecValue,
} from "./helpers.ts";

/**
 * The example tabs of an operation's rail (`RequestPanel.astro`): one per
 * response status, or per webhook payload media type — and one per named
 * example where its `examples` map names two or more, labeled by the
 * example's `summary` (else its key) after the status or media type, so
 * every recorded example shows, under its name. Values are left for the
 * component to highlight.
 */

/** One tab before highlighting. */
export interface ExamplePanel {
  key: string;
  label: string;
  /** The status or media type the tab is under. */
  name: string;
  /** The media type the value is an example of. */
  type: string;
  /** The example, or `null`/`undefined` when there's none to show. */
  value: SpecValue;
  /** What the tab says when there's no example. */
  text: string;
}

/** A response: its description and its body's media types. */
export interface ResponseLike {
  description?: string;
  content?: Record<string, MediaLike>;
}

/** The media entry a body shows: the first JSON-ish one, else the first. */
export const preferredMedia = (
  content?: Record<string, MediaLike>
): [string, MediaLike] | undefined => {
  const entries = Object.entries(content ?? {});
  return entries.find(([type]) => type.includes("json")) ?? entries[0];
};

/**
 * The tabs for one media type: each named example, or the one example
 * `responseExample` gives. Webhook payloads and responses both travel from
 * the API, so both read like a response.
 */
const mediaPanels = (
  name: string,
  type: string,
  media: MediaLike | undefined,
  text: string,
  schemas: Record<string, SchemaLike>,
  components: ComponentsLike | undefined
): ExamplePanel[] => {
  const named = media
    ? namedExamples(media, schemas, "response", components)
    : [];
  if (named.length > 0) {
    return named.map((example) => ({
      key: `${name}-${example.key}`,
      label: `${name} · ${example.label}`,
      name,
      text,
      type,
      value: example.value,
    }));
  }
  return [
    {
      key: name,
      label: name,
      name,
      text,
      type,
      value: media ? responseExample(media, schemas, components) : undefined,
    },
  ];
};

/** The Response tabs: per status, per named example. */
export const responsePanels = (
  responses: Record<string, ResponseLike>,
  schemas: Record<string, SchemaLike>,
  /** A panel's text when its response has no description or example. */
  empty: string,
  components?: ComponentsLike
): ExamplePanel[] =>
  Object.entries(responses).flatMap(([status, response]) => {
    const [type, media] = preferredMedia(response.content) ?? ["", undefined];
    return mediaPanels(
      status,
      type,
      media,
      response.description || empty,
      schemas,
      components
    );
  });

/** A webhook's Payload tabs: per media type, per named example. */
export const payloadPanels = (
  payload: Record<string, MediaLike> | undefined,
  schemas: Record<string, SchemaLike>,
  /** A panel's text when its media type has no example. */
  empty: string,
  components?: ComponentsLike
): ExamplePanel[] =>
  Object.entries(payload ?? {}).flatMap(([type, media]) =>
    mediaPanels(type, type, media, empty, schemas, components)
  );
