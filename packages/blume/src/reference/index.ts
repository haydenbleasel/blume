/**
 * API reference adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { asyncapi, graphql, openapi, scalar } from "blume/reference";
 *
 * export default defineConfig({
 *   reference: [
 *     openapi({ spec: "./openapi.yaml" }),
 *     openapi({ spec: "./legacy.yaml", route: "/legacy", renderer: scalar({ theme: "purple" }) }),
 *     asyncapi({ spec: "./asyncapi.yaml" }),
 *     graphql({ spec: "./schema.graphql", endpoint: "https://api.example.com/graphql" }),
 *   ],
 * });
 * ```
 *
 * Each factory returns a plain descriptor (see `core/adapter.ts`) that the
 * schema validates and the generated site reads as a literal; nothing here
 * runs in the browser.
 */
export type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
export { asyncapi } from "./asyncapi.ts";
export type { AsyncApiAdapter, AsyncApiOptions } from "./asyncapi.ts";
export { graphql } from "./graphql.ts";
export type { GraphqlAdapter, GraphqlOptions } from "./graphql.ts";
export { openapi } from "./openapi.ts";
export type { OpenApiAdapter, OpenApiOptions } from "./openapi.ts";
export type {
  GraphqlSourceOptions,
  PlaygroundOptions,
  ReferenceSourceOptions,
} from "./options.ts";
export { scalar } from "./scalar.ts";
export type { ScalarOptions, ScalarRenderer } from "./scalar.ts";
export type { ReferenceAdapter, ResolvedReferenceAdapter } from "./schema.ts";
