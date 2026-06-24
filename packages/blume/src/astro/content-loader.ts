import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import picomatch from "picomatch";
import { glob as tinyglobby } from "tinyglobby";

interface BlumeContentLoaderOptions {
  additionalBases?: (string | URL)[];
  base: string | URL;
  ignore?: string[];
  pattern: string | string[];
  retainBody?: boolean;
}

interface BlumeEntryType {
  contentModuleTypes?: unknown;
  getEntryInfo: (options: {
    contents: string;
    fileUrl: URL;
  }) => Promise<{ body: string; data: Record<string, unknown> }>;
  getRenderFunction?: (
    config: unknown
  ) => Promise<
    | ((options: {
        body: string;
        data: Record<string, unknown>;
        digest: string;
        filePath: string;
        id: string;
      }) => Promise<BlumeRenderedContent | undefined>)
    | undefined
  >;
}

interface BlumeRenderedContent {
  metadata?: { imagePaths?: string[] };
}

type BlumeRenderFunction = (options: {
  body: string;
  data: Record<string, unknown>;
  digest: string;
  filePath: string;
  id: string;
}) => Promise<BlumeRenderedContent | undefined>;

interface SourceBase {
  dir: URL;
  path: string;
}

interface BlumeStoreEntry {
  assetImports?: string[];
  body?: string;
  data: Record<string, unknown>;
  deferredRender?: boolean;
  digest?: string;
  filePath?: string;
  id: string;
  rendered?: unknown;
}

interface BlumeContentLoaderContext {
  config: { root: URL };
  entryTypes: Map<string, BlumeEntryType>;
  generateDigest: (value: Record<string, unknown> | string) => string;
  logger: {
    error: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  parseData: (options: {
    data: Record<string, unknown>;
    filePath: string;
    id: string;
  }) => Promise<Record<string, unknown>>;
  store: {
    addAssetImports: (assetImports: string[], filePath: string) => void;
    addModuleImport: (filePath: string) => void;
    delete: (id: string) => void;
    get: (id: string) => BlumeStoreEntry | undefined;
    keys: () => IterableIterator<string>;
    set: (entry: BlumeStoreEntry) => void;
  };
  watcher?: {
    add: (path: string) => void;
    on: (
      event: "add" | "change" | "unlink",
      listener: (changedPath: string) => void | Promise<void>
    ) => void;
  };
}

const ensureDirectoryUrl = (url: URL): URL => {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) {
    value.pathname = `${value.pathname}/`;
  }
  return value;
};

const posixRelative = (from: string, to: string): string =>
  path.relative(from, to).split("\\").join("/");

const extension = (file: string): string => {
  const name = file.split("/").pop() ?? file;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
};

const normalizePatterns = (patterns: string | string[]): string[] =>
  Array.isArray(patterns) ? patterns : [patterns];

const sourceBasesFrom = (
  options: BlumeContentLoaderOptions,
  root: URL
): SourceBase[] =>
  [options.base, ...(options.additionalBases ?? [])].map((base) => {
    const dir = ensureDirectoryUrl(new URL(base, root));
    return { dir, path: fileURLToPath(dir) };
  });

const deleteOldId = (
  store: BlumeContentLoaderContext["store"],
  id: string,
  oldId?: string
): void => {
  if (oldId && oldId !== id) {
    store.delete(oldId);
  }
};

const reuseExistingEntry = (options: {
  digest: string;
  existingEntry: BlumeStoreEntry | undefined;
  filePath: string;
  fileToIdMap: Map<string, string>;
  id: string;
  store: BlumeContentLoaderContext["store"];
}): boolean => {
  const { digest, existingEntry, filePath, fileToIdMap, id, store } = options;
  if (!(existingEntry?.digest === digest && existingEntry.filePath)) {
    return false;
  }

  if (existingEntry.deferredRender) {
    store.addModuleImport(existingEntry.filePath);
  }
  if (existingEntry.assetImports?.length) {
    store.addAssetImports(existingEntry.assetImports, existingEntry.filePath);
  }
  fileToIdMap.set(filePath, id);
  return true;
};

const warnDuplicateId = (options: {
  config: { root: URL };
  existingEntry: BlumeStoreEntry | undefined;
  filePath: string;
  id: string;
  logger: BlumeContentLoaderContext["logger"];
  relativePath: string;
}): void => {
  const { config, existingEntry, filePath, id, logger, relativePath } = options;
  if (!(existingEntry?.filePath && existingEntry.filePath !== relativePath)) {
    return;
  }

  const oldFilePath = new URL(existingEntry.filePath, config.root);
  if (existsSync(oldFilePath)) {
    logger.warn(
      `Duplicate id "${id}" found in ${filePath}. Later items with the same id will overwrite earlier ones.`
    );
  }
};

const renderEntry = async (options: {
  body: string;
  config: { root: URL };
  data: Record<string, unknown>;
  digest: string;
  entryType: BlumeEntryType;
  filePath: string;
  id: string;
  renderFunctionByContentType: WeakMap<
    BlumeEntryType,
    BlumeRenderFunction | undefined
  >;
}): Promise<BlumeRenderedContent | undefined> => {
  const {
    body,
    config,
    data,
    digest,
    entryType,
    filePath,
    id,
    renderFunctionByContentType,
  } = options;
  if (!entryType.getRenderFunction) {
    return undefined;
  }

  let render = renderFunctionByContentType.get(entryType);
  if (!render) {
    render = await entryType.getRenderFunction(config);
    renderFunctionByContentType.set(entryType, render);
  }
  return render?.({ body, data, digest, filePath, id });
};

const setStoreEntry = (options: {
  body: string;
  data: Record<string, unknown>;
  digest: string;
  entryType: BlumeEntryType;
  filePath: string;
  id: string;
  parsedData: Record<string, unknown>;
  relativePath: string;
  rendered: BlumeRenderedContent | undefined;
  retainBody: boolean;
  store: BlumeContentLoaderContext["store"];
}): void => {
  const {
    body,
    digest,
    entryType,
    parsedData,
    relativePath,
    rendered,
    retainBody,
    store,
  } = options;
  const shared = {
    body: retainBody ? body : undefined,
    data: parsedData,
    digest,
    filePath: relativePath,
    id: options.id,
  };

  if (entryType.getRenderFunction) {
    store.set({
      ...shared,
      assetImports: rendered?.metadata?.imagePaths,
      rendered,
    });
    return;
  }

  if ("contentModuleTypes" in entryType) {
    store.set({ ...shared, deferredRender: true });
    return;
  }

  store.set(shared);
};

/**
 * Astro's built-in glob loader accepts negated patterns for initial discovery,
 * but its dev watcher uses the full pattern list as a positive matcher. Blume
 * needs real ignores because Mintlify projects use the repository root as the
 * content base and the generated `.blume/.astro` store also lives under that
 * root. This loader follows Astro's content-entry path while applying ignores
 * consistently for initial load and watch events.
 */
export const blumeContentLoader = (
  options: BlumeContentLoaderOptions
): {
  load: (context: BlumeContentLoaderContext) => Promise<void>;
  name: string;
} => {
  const includePatterns = normalizePatterns(options.pattern);
  const ignorePatterns = options.ignore ?? [];
  const includeMatcher = picomatch(includePatterns);
  const ignoreMatcher =
    ignorePatterns.length > 0 ? picomatch(ignorePatterns) : () => false;
  const fileToIdMap = new Map<string, string>();

  const matchesEntry = (entry: string): boolean =>
    !entry.startsWith("../") && includeMatcher(entry) && !ignoreMatcher(entry);

  return {
    async load(context) {
      const {
        config,
        entryTypes,
        generateDigest,
        logger,
        parseData,
        store,
        watcher,
      } = context;
      const renderFunctionByContentType = new WeakMap<
        BlumeEntryType,
        BlumeRenderFunction | undefined
      >();
      const untouchedEntries = new Set(store.keys());
      const sourceBases = sourceBasesFrom(options, config.root);

      const syncData = async (
        entry: string,
        entryType: BlumeEntryType,
        sourceBase: SourceBase,
        oldId?: string
      ): Promise<void> => {
        const fileUrl = new URL(encodeURI(entry), sourceBase.dir);
        const contents = await fs.readFile(fileUrl, "utf-8");
        const { body, data } = await entryType.getEntryInfo({
          contents,
          fileUrl,
        });
        const id = entry;
        deleteOldId(store, id, oldId);

        untouchedEntries.delete(id);
        const existingEntry = store.get(id);
        const digest = generateDigest(contents);
        const filePath = fileURLToPath(fileUrl);
        const relativePath = posixRelative(
          fileURLToPath(config.root),
          filePath
        );

        if (
          reuseExistingEntry({
            digest,
            existingEntry,
            filePath,
            fileToIdMap,
            id,
            store,
          })
        ) {
          return;
        }

        const parsedData = await parseData({ data, filePath, id });
        warnDuplicateId({
          config,
          existingEntry,
          filePath,
          id,
          logger,
          relativePath,
        });
        const rendered = await renderEntry({
          body,
          config,
          data,
          digest,
          entryType,
          filePath,
          id,
          renderFunctionByContentType,
        });
        setStoreEntry({
          body,
          data,
          digest,
          entryType,
          filePath,
          id,
          parsedData,
          relativePath,
          rendered,
          retainBody: options.retainBody !== false,
          store,
        });

        fileToIdMap.set(filePath, id);
      };

      await Promise.all(
        sourceBases.map(async (sourceBase) => {
          if (!existsSync(sourceBase.dir)) {
            logger.warn(
              `The base directory "${sourceBase.path}" does not exist.`
            );
          }

          const files = await tinyglobby(includePatterns, {
            cwd: sourceBase.path,
            expandDirectories: false,
            ignore: ignorePatterns,
            onlyFiles: true,
          });

          await Promise.all(
            files.map(async (entry) => {
              const entryType = entryTypes.get(extension(entry));
              if (!entryType) {
                logger.warn(`No entry type found for ${entry}`);
                return;
              }
              await syncData(entry, entryType, sourceBase);
            })
          );
        })
      );

      for (const id of untouchedEntries) {
        store.delete(id);
      }
      if (!watcher) {
        return;
      }

      for (const sourceBase of sourceBases) {
        watcher.add(sourceBase.path);
      }

      const findSourceBase = (changedPath: string): SourceBase | undefined =>
        sourceBases.find((sourceBase) => {
          const entry = posixRelative(sourceBase.path, changedPath);
          return !entry.startsWith("../");
        });

      const onChange = async (changedPath: string): Promise<void> => {
        const sourceBase = findSourceBase(changedPath);
        if (!sourceBase) {
          return;
        }
        const entry = posixRelative(sourceBase.path, changedPath);
        if (!matchesEntry(entry)) {
          return;
        }
        const entryType = entryTypes.get(extension(entry));
        if (!entryType) {
          return;
        }
        const oldId = fileToIdMap.get(changedPath);
        try {
          await syncData(entry, entryType, sourceBase, oldId);
          logger.info(`Reloaded data from ${entry}`);
        } catch (error) {
          logger.error(
            `Failed to reload ${entry}: ${(error as Error).message}`
          );
        }
      };

      watcher.on("change", onChange);
      watcher.on("add", onChange);
      watcher.on("unlink", (deletedPath) => {
        const sourceBase = findSourceBase(deletedPath);
        if (!sourceBase) {
          return;
        }
        const entry = posixRelative(sourceBase.path, deletedPath);
        if (!matchesEntry(entry)) {
          return;
        }
        const id = fileToIdMap.get(deletedPath);
        if (id) {
          store.delete(id);
          fileToIdMap.delete(deletedPath);
        }
      });
    },
    name: "blume-content-loader",
  };
};
