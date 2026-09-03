import {
  binaryTag,
  CORE_SCHEMA,
  mergeTag,
  omapTag,
  pairsTag,
  setTag,
  timestampTag,
} from "js-yaml";

/**
 * The schema js-yaml 4 loaded with by default: YAML 1.2 core scalars plus the
 * `!!timestamp`, `!!merge`, `!!binary`, `!!omap`, `!!pairs`, and `!!set` tags.
 * js-yaml 5 loads with the bare core schema instead, which turns
 * `date: 2024-01-01` into a string and leaves `<<:` merge keys unresolved — a
 * silent change to every page's front matter. Every Blume `load` call passes
 * this schema so parsing stays identical across the upgrade.
 */
export const YAML_SCHEMA = CORE_SCHEMA.withTags(
  timestampTag,
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag
);
