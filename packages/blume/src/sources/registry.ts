import { z } from "zod";

import { contentful, contentfulAdapterSchema } from "./contentful.ts";
import type { ContentfulAdapter } from "./contentful.ts";
import { custom, customAdapterSchema } from "./custom.ts";
import type { CustomAdapter } from "./custom.ts";
import { filesystem, filesystemAdapterSchema } from "./filesystem.ts";
import type { FilesystemAdapter } from "./filesystem.ts";
import {
  githubReleases,
  githubReleasesAdapterSchema,
} from "./github-releases.ts";
import type { GithubReleasesAdapter } from "./github-releases.ts";
import { mdxRemote, mdxRemoteAdapterSchema } from "./mdx-remote.ts";
import type { MdxRemoteAdapter } from "./mdx-remote.ts";
import { notion, notionAdapterSchema } from "./notion.ts";
import type { NotionAdapter } from "./notion.ts";
import { obsidian, obsidianAdapterSchema } from "./obsidian.ts";
import type { ObsidianAdapter } from "./obsidian.ts";
import { payload, payloadAdapterSchema } from "./payload.ts";
import type { PayloadAdapter } from "./payload.ts";
import { sanity, sanityAdapterSchema } from "./sanity.ts";
import type { SanityAdapter } from "./sanity.ts";
import { strapi, strapiAdapterSchema } from "./strapi.ts";
import type { StrapiAdapter } from "./strapi.ts";

/** Every descriptor a `blume/sources` factory can return. */
export type AnySourceAdapter =
  | FilesystemAdapter
  | MdxRemoteAdapter
  | GithubReleasesAdapter
  | SanityAdapter
  | NotionAdapter
  | ContentfulAdapter
  | PayloadAdapter
  | StrapiAdapter
  | ObsidianAdapter
  | CustomAdapter;

/** Every adapter identity. */
export type SourceAdapterKind = AnySourceAdapter["kind"];

/** One variant per public adapter factory. */
const adapterVariants = [
  filesystemAdapterSchema,
  mdxRemoteAdapterSchema,
  githubReleasesAdapterSchema,
  sanityAdapterSchema,
  notionAdapterSchema,
  contentfulAdapterSchema,
  payloadAdapterSchema,
  strapiAdapterSchema,
  obsidianAdapterSchema,
  customAdapterSchema,
] as const;

const sourceAdapterUnion = z.discriminatedUnion("kind", adapterVariants);

/** What a public factory returns, as the config schema accepts it. */
export type SourceAdapterInput = z.input<typeof sourceAdapterUnion>;

/**
 * A validated descriptor: the adapter's options with their defaults applied
 * (a `filesystem()` entry always carries `root`/`include`/`exclude`), and the
 * metadata lists re-derived from the factory so every consumer reads the
 * `runtimeDeps` and `requiredSecrets` this version of Blume ships.
 */
export type ContentSourceAdapter = z.output<typeof sourceAdapterUnion>;

/** The factory name the 1.x `type` discriminator maps to, for the hint below. */
const FACTORY_FOR_TYPE = new Map([
  ["custom", "custom"],
  ["filesystem", "filesystem"],
  ["github-releases", "githubReleases"],
  ["mdx-remote", "mdxRemote"],
  ["notion", "notion"],
  ["obsidian", "obsidian"],
  ["sanity", "sanity"],
]);

const FACTORIES_HINT =
  'content.sources takes adapters imported from "blume/sources" — filesystem({ root }), mdxRemote({ github }), githubReleases({ owner, repo }), sanity({ projectId, dataset, query }), notion({ database }), contentful({ space, contentType }), payload({ url, collection }), strapi({ url, contentType }), obsidian({ vault }), or custom(source).';

const ARRAY_HINT = `content.sources is a list of adapters — e.g. \`sources: [filesystem({ root: "docs" }), githubReleases({ owner, repo, prefix: "changelog" })]\`, imported from "blume/sources".`;

const isObjectLike = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

/** The 1.x object form's discriminator, when an entry carries one. */
const legacyEntrySchema = z.looseObject({ type: z.string() });

/**
 * The message for an entry that is not a descriptor. A 1.x `{ type: "…" }`
 * object names the factory that replaces it, so the fix is a rename plus
 * moving the remaining fields into the call.
 */
const entryHint = (type: string | undefined): string => {
  if (type === undefined) {
    return FACTORIES_HINT;
  }
  const factory = FACTORY_FOR_TYPE.get(type);
  if (!factory) {
    return `${FACTORIES_HINT} The 1.x { type: "${type}" } object form was removed.`;
  }
  const call =
    type === "custom"
      ? "custom(source) with the source you passed as `source`"
      : `${factory}({ … }) with the other fields as its options`;
  return `${FACTORIES_HINT} The 1.x { type: "${type}", … } object was removed: replace it with ${call}.`;
};

/**
 * Validates a descriptor a factory returned and resolves it to the canonical
 * form, so a descriptor that went through JSON (or was edited by hand)
 * resolves to the same metadata Blume ships.
 */
export const resolvedSourceAdapterSchema = sourceAdapterUnion.transform(
  (value): ContentSourceAdapter => {
    switch (value.kind) {
      case "filesystem": {
        return { ...filesystem(value.options), options: value.options };
      }
      case "github-releases": {
        return { ...githubReleases(value.options), options: value.options };
      }
      case "mdx-remote": {
        return { ...mdxRemote(value.options), options: value.options };
      }
      case "notion": {
        return { ...notion(value.options), options: value.options };
      }
      case "contentful": {
        return { ...contentful(value.options), options: value.options };
      }
      case "payload": {
        return { ...payload(value.options), options: value.options };
      }
      case "strapi": {
        return { ...strapi(value.options), options: value.options };
      }
      case "obsidian": {
        return { ...obsidian(value.options), options: value.options };
      }
      case "sanity": {
        return { ...sanity(value.options), options: value.options };
      }
      default: {
        // Only `custom` is left, and TypeScript has narrowed `value` to it.
        // It returns after the switch rather than from a last case block:
        // Bun 1.4.0's line coverage never credits the closing brace of a
        // switch's final block, which would fail the 100% gate in CI.
        break;
      }
    }
    return custom(value.options);
  }
);

/**
 * One `content.sources` entry. Anything without a `kind` — the 1.x `{ type }`
 * object, a string, `null` — fails here with the factory hint instead of the
 * union's opaque "invalid discriminator" message.
 */
const sourceEntrySchema = z
  .custom<SourceAdapterInput>(
    (value) => isObjectLike(value) && "kind" in value,
    {
      error: (issue) => {
        const legacy = legacyEntrySchema.safeParse(issue.input);
        return entryHint(legacy.success ? legacy.data.type : undefined);
      },
    }
  )
  .pipe(resolvedSourceAdapterSchema);

/**
 * `content.sources`: the adapters to read, in order. A non-array (the 1.x
 * object form, say) fails with the list hint; entry errors keep their own.
 */
export const contentSourcesSchema = z.array(sourceEntrySchema, {
  error: (issue) => (issue.code === "invalid_type" ? ARRAY_HINT : undefined),
});
