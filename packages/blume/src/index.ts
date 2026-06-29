export { defineConfig } from "./core/config.ts";
export { defineComponents } from "./core/define-components.ts";
export type {
  ComponentOverride,
  ComponentOverrides,
  IslandDescriptor,
} from "./core/define-components.ts";
export { defineMeta } from "./core/define-meta.ts";
export type {
  FolderMetaDefinition,
  FolderMetaFactory,
} from "./core/define-meta.ts";
export type {
  BlumeConfig,
  FolderMeta,
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
export { getBlumeVersion } from "./core/version.ts";
