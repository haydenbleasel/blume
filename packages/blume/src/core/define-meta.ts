import type { FolderMeta } from "./schema.ts";

/** A function that computes folder meta, optionally asynchronously. */
export type FolderMetaFactory = () => FolderMeta | Promise<FolderMeta>;

/** What a `meta.ts` may default-export: a plain object or a (async) factory. */
export type FolderMetaDefinition = FolderMeta | FolderMetaFactory;

/**
 * Identity helper for authoring a folder's `meta.ts`. Provides type inference;
 * it does not transform input. Pass an object, or a function (sync or async)
 * that returns one when you need to compute the meta:
 *
 * ```ts
 * export default defineMeta({ title: "Guides", order: 2 });
 * export default defineMeta(async () => ({ pages: await orderPages() }));
 * ```
 */
export const defineMeta = (meta: FolderMetaDefinition): FolderMetaDefinition =>
  meta;
