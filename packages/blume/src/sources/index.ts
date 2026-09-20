/**
 * Content source adapters for `blume.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "blume";
 * import { filesystem, githubReleases } from "blume/sources";
 *
 * export default defineConfig({
 *   content: {
 *     sources: [
 *       filesystem({ root: "docs" }),
 *       githubReleases({ owner: "acme", repo: "sdk", prefix: "changelog" }),
 *     ],
 *   },
 * });
 * ```
 *
 * Each factory returns a plain descriptor (see `core/adapter.ts`) that the
 * schema validates and the CLI reads at scan time; every consumer — the
 * generated `.blume/package.json`, the secrets check, `blume doctor` — reads
 * the descriptor's `runtimeDeps` and `requiredSecrets` instead of switching
 * on a source name. `custom()` is the exception that carries a live
 * {@link ContentSource} instance rather than JSON.
 */
export type { AdapterDescriptor } from "../core/adapter.ts";
export type {
  ContentSource,
  SourceContext,
  SourceEntry,
  SourceLoadResult,
} from "../core/sources/types.ts";
export { contentful } from "./contentful.ts";
export type { ContentfulAdapter, ContentfulOptions } from "./contentful.ts";
export { custom } from "./custom.ts";
export type { CustomAdapter } from "./custom.ts";
export { filesystem } from "./filesystem.ts";
export type { FilesystemAdapter, FilesystemOptions } from "./filesystem.ts";
export { githubReleases } from "./github-releases.ts";
export type {
  GithubReleasesAdapter,
  GithubReleasesOptions,
} from "./github-releases.ts";
export { mdxRemote } from "./mdx-remote.ts";
export type { MdxRemoteAdapter, MdxRemoteOptions } from "./mdx-remote.ts";
export { notion } from "./notion.ts";
export type { NotionAdapter, NotionOptions } from "./notion.ts";
export { obsidian } from "./obsidian.ts";
export type { ObsidianAdapter, ObsidianOptions } from "./obsidian.ts";
export { payload } from "./payload.ts";
export type { PayloadAdapter, PayloadOptions } from "./payload.ts";
export type {
  AnySourceAdapter,
  ContentSourceAdapter,
  SourceAdapterKind,
} from "./registry.ts";
export { sanity } from "./sanity.ts";
export type { SanityAdapter, SanityOptions } from "./sanity.ts";
export type { SharedSourceOptions, SourceFieldMap } from "./shared.ts";
export { strapi } from "./strapi.ts";
export type { StrapiAdapter, StrapiOptions } from "./strapi.ts";
