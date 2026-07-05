export { defineConfig } from "./core/config.ts";
export type {
  BlumeBanner,
  BlumeData,
  BlumeDataConfig,
  BlumeDataI18n,
  BlumeDataLocale,
  BlumeFavicon,
  BlumeFeed,
  BlumeLogo,
  BlumeRoute,
} from "./core/data.ts";
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
export type { UIStrings } from "./core/i18n-ui.ts";
export type { BlumeConfig } from "./core/config-input.ts";
export type {
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
