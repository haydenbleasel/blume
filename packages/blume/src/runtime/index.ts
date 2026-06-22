/**
 * Runtime helpers usable inside `.astro` pages and islands.
 *
 * These give custom pages and components access to Blume project data
 * (config, navigation, page collections) without reaching into generated
 * runtime internals. The surface grows with the customization milestone.
 */
export type {
  Heading,
  NavNode,
  Navigation,
  NavTab,
  PageRecord,
} from "../core/types.ts";
