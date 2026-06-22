/**
 * Public component contracts.
 *
 * Prop types for built-in components are exported here so users can type their
 * overrides (`import type { CalloutProps } from "blume/components"`). Concrete
 * component types are added as components land; the override descriptor types
 * below are stable today.
 */
export type {
  ComponentOverride,
  ComponentOverrides,
  IslandDescriptor,
} from "../core/define-components.ts";
export type { HydrationMode } from "../core/schema.ts";
