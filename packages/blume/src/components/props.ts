// Public prop types for Blume's built-in components, so users can type their
// overrides and wrappers: `import type { CalloutProps } from "blume/components"`.
//
// Each type is derived straight from the component with Astro's `ComponentProps`,
// so it can never drift from the real props. `typeof import(...)` keeps these
// type-only (no runtime import); the file-level disable is because that syntax is
// the only way to reference an `.astro` component's type without a value import.
// The specifiers go through the package's own `blume/components/*` export, not
// `./content/...`: the emitted `dist/types/components/props.d.ts` keeps them as
// written, and `dist/types` has no `.astro` files for a relative path to reach.
// oxlint-disable typescript/consistent-type-imports
import type { ComponentProps } from "astro/types";

export type AccordionProps = ComponentProps<
  typeof import("blume/components/content/Accordion.astro").default
>;
export type AccordionItemProps = ComponentProps<
  typeof import("blume/components/content/AccordionItem.astro").default
>;
export type BadgeProps = ComponentProps<
  typeof import("blume/components/content/Badge.astro").default
>;
export type CalloutProps = ComponentProps<
  typeof import("blume/components/content/Callout.astro").default
>;
export type CardProps = ComponentProps<
  typeof import("blume/components/content/Card.astro").default
>;
export type CardGroupProps = ComponentProps<
  typeof import("blume/components/content/CardGroup.astro").default
>;
export type CodeGroupProps = ComponentProps<
  typeof import("blume/components/content/CodeGroup.astro").default
>;
export type ColumnProps = ComponentProps<
  typeof import("blume/components/content/Column.astro").default
>;
export type ColumnsProps = ComponentProps<
  typeof import("blume/components/content/Columns.astro").default
>;
export type ExpandableProps = ComponentProps<
  typeof import("blume/components/content/Expandable.astro").default
>;
export type FrameProps = ComponentProps<
  typeof import("blume/components/content/Frame.astro").default
>;
export type PanelProps = ComponentProps<
  typeof import("blume/components/content/Panel.astro").default
>;
export type ParamFieldProps = ComponentProps<
  typeof import("blume/components/content/ParamField.astro").default
>;
export type PromptProps = ComponentProps<
  typeof import("blume/components/content/Prompt.astro").default
>;
export type ResponseFieldProps = ComponentProps<
  typeof import("blume/components/content/ResponseField.astro").default
>;
export type StepProps = ComponentProps<
  typeof import("blume/components/content/Step.astro").default
>;
export type StepsProps = ComponentProps<
  typeof import("blume/components/content/Steps.astro").default
>;
export type TabProps = ComponentProps<
  typeof import("blume/components/content/Tab.astro").default
>;
export type TabsProps = ComponentProps<
  typeof import("blume/components/content/Tabs.astro").default
>;
export type TileProps = ComponentProps<
  typeof import("blume/components/content/Tile.astro").default
>;
export type TooltipProps = ComponentProps<
  typeof import("blume/components/content/Tooltip.astro").default
>;
export type YouTubeProps = ComponentProps<
  typeof import("blume/components/content/YouTube.astro").default
>;
export type IconProps = ComponentProps<
  typeof import("blume/components/Icon.astro").default
>;
