export { defineConfig } from "./core/config.ts";
export { defineComponents } from "./core/define-components.ts";
export type {
  ComponentOverride,
  ComponentOverrides,
  IslandDescriptor,
} from "./core/define-components.ts";
export type {
  BlumeConfig,
  HydrationMode,
  ResolvedConfig,
} from "./core/schema.ts";
export type {
  Diagnostic,
  Heading,
  NavNode,
  Navigation,
  NavTab,
  PageRecord,
} from "./core/types.ts";
export { BLUME_VERSION } from "./core/version.ts";
