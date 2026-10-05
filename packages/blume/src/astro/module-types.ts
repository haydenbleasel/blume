/**
 * Ambient declarations for the `blume:*` virtual modules the generated pages
 * and Blume's own layouts import. The integration hands them to Astro through
 * `injectTypes` on `astro:config:done`, so they land under
 * `.astro/integrations/blume/` and are referenced from Astro's generated
 * `types.d.ts` — the same channel `astro:content` and `astro:env` use — rather
 * than a hand-written `src/env.d.ts` the generator and eject each had to
 * write. Every project that mounts the integration gets the types with it.
 *
 * `examplesModule` is the path of the generated `examples.ts` relative to the
 * declaration file: the `blume:examples` map is typed from that module's
 * literal export so `<Component path>` lookups stay typed per project.
 */
export const runtimeModuleDeclarations = (
  examplesModule: string
): string => `declare module "blume:ask" {
  const Ask: typeof import("blume/components/islands/Assistant.astro").default;
  export default Ask;
}

declare module "blume:data" {
  const data: import("blume").BlumeData;
  export default data;
}

declare module "blume:ask-data" {
  const askData: import("blume/ai/ask-context.ts").AskData;
  export default askData;
}

declare module "blume:content-assets" {
  const assets: Record<string, string>;
  export default assets;
}

declare module "blume:mcp-data" {
  const data: import("blume/ai/mcp/data.ts").McpData;
  export default data;
}

declare module "blume:raw-markdown" {
  const raw: Record<string, import("blume/ai/markdown.ts").RawMarkdownEntry>;
  export default raw;
}

declare module "blume:rss" {
  const feeds: Record<string, string>;
  export default feeds;
}

declare module "blume:search-index" {
  const documents: import("blume/search/documents.ts").SearchDocument[];
  export default documents;
}

declare module "blume:examples" {
  type Examples = typeof import(${JSON.stringify(examplesModule)}).examples;
  export const examples: Record<string, Examples[keyof Examples]>;
  export const examplesBase: string;
}

declare module "blume:examples-theme";

declare module "blume:openapi" {
  const specs: import("blume/openapi/model.ts").OpenApiData;
  export default specs;
}

declare module "blume:features" {
  /** Registers the <blume-mermaid> element; null when no page has a mermaid fence. */
  export const loadMermaid: (() => Promise<unknown>) | null;
  /** The EPUB generator's browser bundle; null when export.epub is off. */
  export const loadEpub:
    | (() => Promise<typeof import("epub-gen-memory/bundle")>)
    | null;
}

declare module "blume:consent-client" {
  export const startConsentClient: (
    consent: import("blume/components/layout/consent/types.ts").BlumeConsent
  ) => void;
}

declare module "blume:search-client" {
  export const createSearch: (
    options?: import("blume/components/layout/search/types.ts").SearchClientOptions
  ) =>
    | import("blume/components/layout/search/types.ts").SearchFn
    | Promise<import("blume/components/layout/search/types.ts").SearchFn>;
}
`;
