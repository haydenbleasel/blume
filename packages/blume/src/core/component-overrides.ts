import { existsSync } from "node:fs";

import { dirname, extname, isAbsolute, resolve } from "pathe";
import ts from "typescript";

import type { HydrationMode } from "./schema.ts";

/**
 * Static analysis of a user `components.ts`/`.tsx`.
 *
 * Astro can only hydrate a component it imports *statically by path*, so to honor
 * hydration on overrides (the `islands` group and `client:*` layout/mdx
 * descriptors) Blume needs each override's source path and client mode at
 * generate time — before Vite compiles anything. We read that here by parsing the
 * file with the TypeScript compiler API (never executing it, so `.astro`/React
 * imports don't need a Node loader).
 *
 * Only statically-analyzable authoring is understood: a default export that is an
 * object literal or a `defineComponents({ ... })` call, with entries that are
 * imported identifiers, path strings, or `{ component, client, media }` object
 * literals. Anything else falls back to the runtime overrides object (which can
 * still render a static component, just not hydrate it).
 */

export type OverrideFramework = "react" | "svelte" | "vue";

/** How a wrapper should import an override's component. */
export interface OverrideImport {
  /** Framework inferred from the file extension, or null (e.g. `.astro`). */
  framework: OverrideFramework | null;
  /** Exported name to import: `"default"` or a named export. */
  name: string;
  /** Absolute path (for relative/absolute specifiers) or a bare specifier. */
  path: string;
}

/** A normalized override entry, keyed by its MDX tag / layout-slot name. */
export interface NormalizedOverride {
  /** Present when the override should hydrate; drives the `client:*` directive. */
  client?: HydrationMode;
  /**
   * True when the value is a bare imported identifier, so the runtime overrides
   * object already holds a usable component (no generated import needed for a
   * non-hydrated entry). False for path strings and `{ component }` descriptors.
   */
  identifier: boolean;
  key: string;
  /** Media query for `client: "media"`. */
  media?: string;
  /**
   * How to obtain the component. `null` means it couldn't be resolved to a file,
   * so the runtime overrides object is used (static render only).
   */
  source: OverrideImport | null;
}

export interface ComponentOverrideAnalysis {
  islands: NormalizedOverride[];
  layout: NormalizedOverride[];
  mdx: NormalizedOverride[];
  warnings: string[];
}

const GROUPS = ["mdx", "layout", "islands"] as const;
const GROUP_SET = new Set<string>(GROUPS);
type Group = (typeof GROUPS)[number];

const FRAMEWORK_BY_EXT: Record<string, OverrideFramework> = {
  jsx: "react",
  svelte: "svelte",
  tsx: "react",
  vue: "vue",
};

const FRAMEWORK_LABEL: Record<OverrideFramework, string> = {
  react: "React",
  svelte: "Svelte",
  vue: "Vue",
};

/** Extensions probed (in order) when a specifier omits one. */
const COMPONENT_EXTS = [
  "astro",
  "tsx",
  "ts",
  "jsx",
  "js",
  "mjs",
  "vue",
  "svelte",
];

const HYDRATION_MODES = new Set<HydrationMode>([
  "idle",
  "load",
  "media",
  "only",
  "visible",
]);

interface ImportBinding {
  /** Exported name: `"default"` or a named export. */
  imported: string;
  specifier: string;
}

/** An override's declared component before framework/path resolution. */
interface RawDescriptor {
  client?: HydrationMode;
  hadComponent: boolean;
  media?: string;
  source: OverrideImport | null;
}

const emptyAnalysis = (): ComponentOverrideAnalysis => ({
  islands: [],
  layout: [],
  mdx: [],
  warnings: [],
});

const propName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** Record the bindings declared by one import statement into `map`. */
const addImportBindings = (
  map: Map<string, ImportBinding>,
  statement: ts.Statement
): void => {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return;
  }
  const specifier = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (!clause) {
    return;
  }
  if (clause.name) {
    map.set(clause.name.text, { imported: "default", specifier });
  }
  const named = clause.namedBindings;
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      map.set(element.name.text, {
        imported: (element.propertyName ?? element.name).text,
        specifier,
      });
    }
  }
};

/** Map each local binding name to the module + exported name it came from. */
const collectImports = (
  sourceFile: ts.SourceFile
): Map<string, ImportBinding> => {
  const map = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    addImportBindings(map, statement);
  }
  return map;
};

/** Unwrap `defineComponents({...})`, `({...})`, or `{...} as T` to the object. */
const unwrapObject = (
  expression: ts.Expression
): ts.ObjectLiteralExpression | undefined => {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isCallExpression(expression)) {
    const [arg] = expression.arguments;
    return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapObject(expression.expression);
  }
  return undefined;
};

const findDefaultExportObject = (
  sourceFile: ts.SourceFile
): ts.ObjectLiteralExpression | undefined => {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return unwrapObject(statement.expression);
    }
  }
  return undefined;
};

const probeExtension = (base: string): string | null => {
  for (const extension of COMPONENT_EXTS) {
    const candidate = `${base}.${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

/** Resolve a module specifier to a wrapper-importable path + framework. */
const toImport = (
  specifier: string,
  imported: string,
  dir: string
): OverrideImport => {
  const relative = specifier.startsWith(".") || isAbsolute(specifier);
  let path = specifier;
  let extension = extname(specifier).slice(1).toLowerCase();
  if (relative) {
    const absolute = isAbsolute(specifier)
      ? specifier
      : resolve(dir, specifier);
    if (extension) {
      path = absolute;
    } else {
      const probed = probeExtension(absolute);
      path = probed ?? absolute;
      extension = probed ? extname(probed).slice(1).toLowerCase() : "";
    }
  }
  return {
    framework: FRAMEWORK_BY_EXT[extension] ?? null,
    name: imported,
    path,
  };
};

const resolveIdentifier = (
  name: string,
  imports: Map<string, ImportBinding>,
  dir: string
): OverrideImport | null => {
  const binding = imports.get(name);
  return binding ? toImport(binding.specifier, binding.imported, dir) : null;
};

/** Fold one descriptor-object property into the accumulating descriptor. */
const applyDescriptorProperty = (
  descriptor: RawDescriptor,
  property: ts.ObjectLiteralElementLike,
  imports: Map<string, ImportBinding>,
  dir: string
): void => {
  if (ts.isShorthandPropertyAssignment(property)) {
    if (property.name.text === "component") {
      descriptor.hadComponent = true;
      descriptor.source = resolveIdentifier(property.name.text, imports, dir);
    }
    return;
  }
  if (!ts.isPropertyAssignment(property)) {
    return;
  }
  const name = propName(property.name);
  const init = property.initializer;
  if (name === "component") {
    descriptor.hadComponent = true;
    if (ts.isStringLiteral(init)) {
      descriptor.source = toImport(init.text, "default", dir);
    } else if (ts.isIdentifier(init)) {
      descriptor.source = resolveIdentifier(init.text, imports, dir);
    }
  } else if (
    name === "client" &&
    ts.isStringLiteral(init) &&
    HYDRATION_MODES.has(init.text as HydrationMode)
  ) {
    descriptor.client = init.text as HydrationMode;
  } else if (name === "media" && ts.isStringLiteral(init)) {
    descriptor.media = init.text;
  }
};

const readDescriptor = (
  object: ts.ObjectLiteralExpression,
  imports: Map<string, ImportBinding>,
  dir: string
): RawDescriptor => {
  const descriptor: RawDescriptor = { hadComponent: false, source: null };
  for (const property of object.properties) {
    applyDescriptorProperty(descriptor, property, imports, dir);
  }
  return descriptor;
};

/** Apply cross-cutting validation and produce the final normalized override. */
const finalize = (
  key: string,
  group: Group,
  descriptor: RawDescriptor,
  label: string,
  identifier: boolean,
  warnings: string[]
): NormalizedOverride | null => {
  const { client, media, source } = descriptor;

  if (group === "islands") {
    if (!source) {
      warnings.push(
        `Island override "${key}" couldn't be resolved to a file. Reference it by an imported component or a path string with an extension.`
      );
      return null;
    }
    if (!source.framework) {
      warnings.push(
        `Island override "${key}" (${label}) is not a React, Vue, or Svelte component; only framework components can be islands.`
      );
      return null;
    }
  }

  if (client === "media" && !media) {
    warnings.push(
      `Override "${key}" uses client: "media" but no \`media\` query was given; it will hydrate as if \`client: "load"\`.`
    );
  }

  if (client === "only" && source && !source.framework) {
    warnings.push(
      `Override "${key}" uses client: "only" but its framework couldn't be inferred; reference a .tsx/.jsx/.vue/.svelte file.`
    );
  }

  if (client && !source) {
    warnings.push(
      `Override "${key}" declares client: "${client}" but its component couldn't be resolved to a file, so it can't hydrate. Reference it by an imported component or a path string.`
    );
    return { identifier, key, source: null };
  }

  if (!client && source?.framework) {
    warnings.push(
      `Override "${key}" points to a ${FRAMEWORK_LABEL[source.framework]} component (${label}) but has no hydration mode, so it renders as static HTML with no interactivity. Add one, e.g. \`${key}: { component: ${JSON.stringify(label)}, client: "load" }\`.`
    );
  }

  return {
    identifier,
    key,
    ...(client ? { client } : {}),
    ...(media ? { media } : {}),
    source,
  };
};

const normalizeEntry = (
  entry: ts.ObjectLiteralElementLike,
  group: Group,
  imports: Map<string, ImportBinding>,
  dir: string,
  warnings: string[]
): NormalizedOverride | null => {
  const defaultClient: HydrationMode | undefined =
    group === "islands" ? "visible" : undefined;

  if (ts.isShorthandPropertyAssignment(entry)) {
    const name = entry.name.text;
    return finalize(
      name,
      group,
      {
        client: defaultClient,
        hadComponent: true,
        source: resolveIdentifier(name, imports, dir),
      },
      name,
      true,
      warnings
    );
  }

  if (!ts.isPropertyAssignment(entry)) {
    return null;
  }
  const key = propName(entry.name);
  if (!key) {
    return null;
  }
  const value = entry.initializer;

  if (ts.isIdentifier(value)) {
    return finalize(
      key,
      group,
      {
        client: defaultClient,
        hadComponent: true,
        source: resolveIdentifier(value.text, imports, dir),
      },
      value.text,
      true,
      warnings
    );
  }
  if (ts.isStringLiteral(value)) {
    return finalize(
      key,
      group,
      {
        client: defaultClient,
        hadComponent: true,
        source: toImport(value.text, "default", dir),
      },
      value.text,
      false,
      warnings
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    const descriptor = readDescriptor(value, imports, dir);
    if (!descriptor.hadComponent) {
      warnings.push(
        `Override "${key}" is an object without a \`component\` field; expected \`{ component, client }\`.`
      );
      return null;
    }
    if (!descriptor.source) {
      warnings.push(
        `Override "${key}"'s \`component\` couldn't be resolved to a file. Reference an imported component or a path string with an extension.`
      );
      return null;
    }
    return finalize(
      key,
      group,
      { ...descriptor, client: descriptor.client ?? defaultClient },
      key,
      false,
      warnings
    );
  }

  // An inline function/expression: keep it on the runtime object (static only).
  return { identifier: false, key, source: null };
};

/** Normalize one top-level `{ mdx | layout | islands }` group into `result`. */
const collectGroupOverrides = (
  property: ts.ObjectLiteralElementLike,
  imports: Map<string, ImportBinding>,
  dir: string,
  result: ComponentOverrideAnalysis
): void => {
  if (!ts.isPropertyAssignment(property)) {
    return;
  }
  const name = propName(property.name);
  if (
    !(name && GROUP_SET.has(name)) ||
    !ts.isObjectLiteralExpression(property.initializer)
  ) {
    return;
  }
  const group = name as Group;
  for (const entry of property.initializer.properties) {
    const normalized = normalizeEntry(
      entry,
      group,
      imports,
      dir,
      result.warnings
    );
    if (normalized) {
      result[group].push(normalized);
    }
  }
};

/**
 * Parse a user `components.ts`/`.tsx` and return its normalized overrides. Never
 * executes the file. On a parse failure or unrecognized shape, returns empty
 * groups so generation falls back to the plain runtime overrides object.
 */
export const analyzeComponentOverrides = (
  source: string,
  filePath: string
): ComponentOverrideAnalysis => {
  const result = emptyAnalysis();
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const object = findDefaultExportObject(sourceFile);
  if (!object) {
    return result;
  }

  const imports = collectImports(sourceFile);
  const dir = dirname(filePath);

  for (const property of object.properties) {
    collectGroupOverrides(property, imports, dir, result);
  }

  return result;
};
