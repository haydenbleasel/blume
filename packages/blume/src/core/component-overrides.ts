import { existsSync } from "node:fs";

import { basename, dirname, extname, isAbsolute, join, resolve } from "pathe";
import ts from "typescript";

import { BlumeError } from "./diagnostics.ts";
import type { HydrationMode } from "./schema.ts";
import type { Diagnostic } from "./types.ts";

/**
 * Static analysis of a user `components.ts`/`.tsx`.
 *
 * Astro can only hydrate a component it imports *statically by path*, so to honor
 * hydration on overrides Blume needs each override's source path and client mode
 * at generate time — before Vite compiles anything. We read that here by parsing
 * the file with the TypeScript compiler API (never executing it, so `.astro`/React
 * imports don't need a Node loader).
 *
 * Only statically-analyzable authoring is accepted: a default export that is an
 * object literal or a `defineComponents({ ... })` call, whose `mdx`/`layout`
 * groups are object literals with entries that are imported identifiers, path
 * strings, or `{ component, client, media }` object literals, and a relative
 * or absolute path must name a file that exists. Anything else is a config
 * error ({@link ComponentOverridesError}, `BLUME_COMPONENTS_INVALID`) naming the
 * entry, its line, and the accepted forms — there is no runtime fallback, so an
 * override that can't be planned never silently renders without hydration, and
 * a missing file never surfaces as a bundler error inside the generated runtime.
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
  key: string;
  /** Media query for `client: "media"`. */
  media?: string;
  /** How to obtain the component. */
  source: OverrideImport;
}

export interface ComponentOverrideAnalysis {
  layout: NormalizedOverride[];
  mdx: NormalizedOverride[];
  warnings: string[];
}

/** The analysis of a project with no `components.ts`. */
export const emptyComponentOverrides = (): ComponentOverrideAnalysis => ({
  layout: [],
  mdx: [],
  warnings: [],
});

const GROUPS = ["mdx", "layout"] as const;
const GROUP_SET = new Set<string>(GROUPS);
type Group = (typeof GROUPS)[number];

const isGroup = (name: string): name is Group => GROUP_SET.has(name);

/**
 * The `layout` keys the built-in chrome reads (`RootLayout.astro` and
 * `Header.astro`). Any other key is never rendered, so it's warned about
 * rather than silently dropped; a typo or wrong case would otherwise leave
 * the built-in in place with no sign why.
 */
const LAYOUT_SLOTS = [
  "Layout",
  "Header",
  "Logo",
  "Search",
  "Sidebar",
  "MobileNav",
  "Breadcrumbs",
  "TableOfContents",
  "Pagination",
  "Feedback",
  "PageHeader",
  "PageFooter",
  "Footer",
];
const LAYOUT_SLOT_SET: ReadonlySet<string> = new Set(LAYOUT_SLOTS);

/** The authoring forms an override accepts; the fix every rejection points at. */
export const ACCEPTED_OVERRIDE_FORMS =
  "Each override must be an imported identifier, a path string, or a `{ component, client, media }` object literal whose `component` is an imported identifier or a path string.";

const FRAMEWORK_BY_EXT = new Map<string, OverrideFramework>([
  ["jsx", "react"],
  ["svelte", "svelte"],
  ["tsx", "react"],
  ["vue", "vue"],
]);

const FRAMEWORK_LABEL = {
  react: "React",
  svelte: "Svelte",
  vue: "Vue",
} satisfies Record<OverrideFramework, string>;

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

const HYDRATION_MODES: ReadonlySet<string> = new Set<HydrationMode>([
  "idle",
  "load",
  "media",
  "only",
  "visible",
]);

const HYDRATION_MODE_LIST = '"load", "idle", "visible", "media", or "only"';

const isHydrationMode = (value: string): value is HydrationMode =>
  HYDRATION_MODES.has(value);

interface ImportBinding {
  /** Exported name: `"default"` or a named export. */
  imported: string;
  /** The import statement, where a missing file is reported. */
  node: ts.ImportDeclaration;
  specifier: string;
}

/** Why one entry was rejected, and the node it's about (for its line). */
interface Rejection {
  message: string;
  /** A path that names no file: the fix is the path, not the entry's form. */
  missingFile?: boolean;
  node?: ts.Node;
}

/** An override's declared component before framework/path resolution. */
interface RawDescriptor {
  client?: HydrationMode;
  media?: string;
  source: OverrideImport | null;
}

/** Everything one analysis pass needs to resolve and report an entry. */
interface AnalysisContext {
  dir: string;
  /** Rejections collected across the file; thrown together at the end. */
  errors: Rejection[];
  imports: Map<string, ImportBinding>;
  warnings: string[];
}

const reject = (
  context: AnalysisContext,
  message: string,
  node?: ts.Node,
  missingFile?: boolean
): void => {
  context.errors.push({ message, missingFile, node });
};

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
    map.set(clause.name.text, {
      imported: "default",
      node: statement,
      specifier,
    });
  }
  const named = clause.namedBindings;
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      map.set(element.name.text, {
        imported: (element.propertyName ?? element.name).text,
        node: statement,
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

const findDefaultExport = (
  sourceFile: ts.SourceFile
): ts.ExportAssignment | undefined =>
  sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals
  );

const probeExtension = (base: string): string | null => {
  for (const extension of COMPONENT_EXTS) {
    const candidate = `${base}.${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

// A `.js` specifier in a TypeScript file may name its `.ts`/`.tsx` source, as
// Vite resolves it; the same holds for `.jsx` and `.mjs`.
const SCRIPT_EXT = /\.(?:jsx?|mjs)$/u;
const TS_SOURCE_EXTS = ["ts", "tsx", "mts"];

/**
 * Whether a local path names something the bundler can import: the file
 * itself, the file with a component extension added, a folder's `index`, or
 * the TypeScript source a `.js` specifier stands for.
 */
const resolvesLocally = (absolute: string): boolean => {
  if (existsSync(absolute) || probeExtension(absolute)) {
    return true;
  }
  if (probeExtension(join(absolute, "index"))) {
    return true;
  }
  const base = absolute.replace(SCRIPT_EXT, "");
  return (
    base !== absolute &&
    TS_SOURCE_EXTS.some((extension) => existsSync(`${base}.${extension}`))
  );
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
    framework: FRAMEWORK_BY_EXT.get(extension) ?? null,
    name: imported,
    path,
  };
};

/**
 * Resolve a specifier to its import, or record that the file it names doesn't
 * exist. A bare package specifier is left to the bundler.
 */
const sourceFor = (
  specifier: string,
  imported: string,
  label: string,
  node: ts.Node,
  context: AnalysisContext
): OverrideImport | null => {
  const local = specifier.startsWith(".") || isAbsolute(specifier);
  if (local && !resolvesLocally(resolve(context.dir, specifier))) {
    reject(
      context,
      `${label} points at "${specifier}", but no file exists there; fix the path or restore the file.`,
      node,
      true
    );
    return null;
  }
  return toImport(specifier, imported, context.dir);
};

/**
 * Resolve an identifier to the import it names, or record why it can't be: a
 * local binding (a `const`, a function declared in the file) has no source path
 * a wrapper could import.
 */
const resolveIdentifier = (
  name: string,
  label: string,
  node: ts.Node,
  context: AnalysisContext
): OverrideImport | null => {
  const binding = context.imports.get(name);
  if (binding) {
    return sourceFor(
      binding.specifier,
      binding.imported,
      label,
      binding.node,
      context
    );
  }
  reject(
    context,
    `${label} refers to "${name}", which isn't imported in this file; import the component from its file.`,
    node
  );
  return null;
};

const ALLOWED_FIELDS =
  "only `component`, `client`, and `media` are allowed in a descriptor.";

/** Fold one descriptor-object property into the accumulating descriptor. */
const applyDescriptorProperty = (
  descriptor: RawDescriptor,
  property: ts.ObjectLiteralElementLike,
  label: string,
  context: AnalysisContext
): void => {
  if (ts.isShorthandPropertyAssignment(property)) {
    if (property.name.text === "component") {
      descriptor.source = resolveIdentifier(
        property.name.text,
        `${label}'s \`component\``,
        property,
        context
      );
      return;
    }
    const shorthand = property.name.text;
    if (shorthand === "client" || shorthand === "media") {
      reject(
        context,
        `${label} writes \`${shorthand}\` as a shorthand property; only \`component\` may be shorthand, \`${shorthand}\` must be a string literal.`,
        property
      );
      return;
    }
    reject(
      context,
      `${label} has a \`${shorthand}\` field; ${ALLOWED_FIELDS}`,
      property
    );
    return;
  }
  if (!ts.isPropertyAssignment(property)) {
    reject(
      context,
      `${label} contains a spread, method, or accessor; write it as a plain \`{ component, client, media }\` object literal.`,
      property
    );
    return;
  }
  const name = propName(property.name);
  const init = property.initializer;
  if (name === "component") {
    if (ts.isStringLiteral(init)) {
      descriptor.source = sourceFor(
        init.text,
        "default",
        `${label}'s \`component\``,
        init,
        context
      );
    } else if (ts.isIdentifier(init)) {
      descriptor.source = resolveIdentifier(
        init.text,
        `${label}'s \`component\``,
        init,
        context
      );
    } else {
      reject(
        context,
        `${label}'s \`component\` must be an imported identifier or a path string.`,
        init
      );
    }
  } else if (name === "client") {
    if (ts.isStringLiteral(init) && isHydrationMode(init.text)) {
      descriptor.client = init.text;
    } else {
      reject(
        context,
        `${label}'s \`client\` must be a string literal: ${HYDRATION_MODE_LIST}.`,
        init
      );
    }
  } else if (name === "media") {
    if (ts.isStringLiteral(init)) {
      descriptor.media = init.text;
    } else {
      reject(context, `${label}'s \`media\` must be a string literal.`, init);
    }
  } else {
    reject(
      context,
      `${label} has a \`${name ?? property.name.getText()}\` field; ${ALLOWED_FIELDS}`,
      property
    );
  }
};

/**
 * Read a `{ component, client, media }` descriptor. Returns null (after
 * recording the reason) when it can't be planned.
 */
const readDescriptor = (
  object: ts.ObjectLiteralExpression,
  label: string,
  context: AnalysisContext
): RawDescriptor | null => {
  const descriptor: RawDescriptor = { source: null };
  const before = context.errors.length;
  let hadComponent = false;
  for (const property of object.properties) {
    if (property.name && propName(property.name) === "component") {
      hadComponent = true;
    }
    applyDescriptorProperty(descriptor, property, label, context);
  }
  if (!hadComponent) {
    reject(
      context,
      `${label} is an object literal without a \`component\` field.`,
      object
    );
  }
  return context.errors.length === before ? descriptor : null;
};

/** Apply cross-cutting validation and produce the final normalized override. */
const finalize = (
  key: string,
  descriptor: RawDescriptor,
  label: string,
  warnings: string[]
): NormalizedOverride | null => {
  const { client, media, source } = descriptor;
  if (!source) {
    return null;
  }

  if (client === "media" && !media) {
    warnings.push(
      `Override "${key}" uses client: "media" but no \`media\` query was given; it will hydrate as if \`client: "load"\`.`
    );
  }

  if (client === "only" && !source.framework) {
    warnings.push(
      `Override "${key}" uses client: "only" but its framework couldn't be inferred; reference a .tsx/.jsx/.vue/.svelte file.`
    );
  }

  if (!client && source.framework) {
    warnings.push(
      `Override "${key}" points to a ${FRAMEWORK_LABEL[source.framework]} component (${label}) but has no hydration mode, so it renders as static HTML with no interactivity. Add one, e.g. \`${key}: { component: ${JSON.stringify(label)}, client: "load" }\`.`
    );
  }

  const normalized: NormalizedOverride = { key, source };
  if (client) {
    normalized.client = client;
  }
  if (media) {
    normalized.media = media;
  }
  return normalized;
};

/** Normalize one `key: value` entry of a group, or record why it's rejected. */
const normalizeEntry = (
  entry: ts.ObjectLiteralElementLike,
  group: Group,
  context: AnalysisContext
): NormalizedOverride | null => {
  const { warnings } = context;

  if (ts.isShorthandPropertyAssignment(entry)) {
    const name = entry.name.text;
    return finalize(
      name,
      { source: resolveIdentifier(name, `${group}.${name}`, entry, context) },
      name,
      warnings
    );
  }

  if (ts.isSpreadAssignment(entry)) {
    reject(
      context,
      `${group} contains a spread (\`...${entry.expression.getText()}\`); list each override explicitly.`,
      entry
    );
    return null;
  }
  const key = propName(entry.name);
  if (!key) {
    reject(
      context,
      `${group} has an entry with a computed key (\`${entry.name.getText()}\`); keys must be plain names.`,
      entry
    );
    return null;
  }
  const label = `${group}.${key}`;
  if (!ts.isPropertyAssignment(entry)) {
    reject(
      context,
      `${label} is a method or accessor, which Blume can't analyze statically.`,
      entry
    );
    return null;
  }
  const value = entry.initializer;

  if (ts.isIdentifier(value)) {
    return finalize(
      key,
      { source: resolveIdentifier(value.text, label, entry, context) },
      value.text,
      warnings
    );
  }
  if (ts.isStringLiteral(value)) {
    return finalize(
      key,
      { source: sourceFor(value.text, "default", label, value, context) },
      value.text,
      warnings
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    const descriptor = readDescriptor(value, label, context);
    return descriptor ? finalize(key, descriptor, key, warnings) : null;
  }

  reject(
    context,
    `${label} is an inline expression, which Blume can't analyze statically.`,
    entry
  );
  return null;
};

/** Normalize one top-level `{ mdx | layout }` group into `result`. */
const collectGroupOverrides = (
  property: ts.ObjectLiteralElementLike,
  context: AnalysisContext,
  result: ComponentOverrideAnalysis
): void => {
  if (ts.isSpreadAssignment(property)) {
    reject(
      context,
      `The top-level object contains a spread (\`...${property.expression.getText()}\`); list \`mdx\` and \`layout\` explicitly.`,
      property
    );
    return;
  }
  const name = propName(property.name);
  if (name === "islands") {
    reject(
      context,
      'The `islands` group was folded into `mdx`: move each entry there and give it a `client` mode, e.g. `mdx: { Counter: { component: Counter, client: "visible" } }`.',
      property
    );
    return;
  }
  if (!(name && isGroup(name))) {
    reject(
      context,
      `\`${name ?? property.name.getText()}\` isn't an override group; use \`mdx\` or \`layout\`.`,
      property
    );
    return;
  }
  if (
    !ts.isPropertyAssignment(property) ||
    !ts.isObjectLiteralExpression(property.initializer)
  ) {
    reject(
      context,
      `\`${name}\` must be an object literal of overrides.`,
      property
    );
    return;
  }
  for (const entry of property.initializer.properties) {
    const normalized = normalizeEntry(entry, name, context);
    if (normalized) {
      result[name].push(normalized);
    }
    if (
      name === "layout" &&
      normalized &&
      !LAYOUT_SLOT_SET.has(normalized.key)
    ) {
      context.warnings.push(
        `Layout override "${normalized.key}" isn't a layout slot, so nothing renders it. Use one of: ${LAYOUT_SLOTS.join(", ")}.`
      );
    }
  }
};

/**
 * A `components.ts` Blume can't plan. The diagnostic lists every rejected entry
 * at once (at the first one's line); `issues` holds each on its own, with its
 * line, for a caller that reports them one by one (`blume upgrade`).
 */
export class ComponentOverridesError extends BlumeError {
  readonly issues: Diagnostic[];

  constructor(diagnostic: Diagnostic, issues: Diagnostic[]) {
    super(diagnostic);
    this.name = "ComponentOverridesError";
    this.issues = issues;
  }
}

/** A rejection as a diagnostic, at its node's line when it has one. */
const rejectionDiagnostic = (
  filePath: string,
  sourceFile: ts.SourceFile,
  rejection: Rejection
): Diagnostic => {
  const position = rejection.node
    ? sourceFile.getLineAndCharacterOfPosition(
        rejection.node.getStart(sourceFile)
      )
    : undefined;
  return {
    code: "BLUME_COMPONENTS_INVALID",
    column: position && position.character + 1,
    file: filePath,
    line: position && position.line + 1,
    message: rejection.message,
    severity: "error",
    suggestion: rejection.missingFile ? undefined : ACCEPTED_OVERRIDE_FORMS,
  };
};

const invalidOverrides = (
  filePath: string,
  sourceFile: ts.SourceFile,
  rejections: Rejection[]
): ComponentOverridesError => {
  const issues = rejections.map((rejection) =>
    rejectionDiagnostic(filePath, sourceFile, rejection)
  );
  const first = issues.find((issue) => issue.line !== undefined);
  return new ComponentOverridesError(
    {
      code: "BLUME_COMPONENTS_INVALID",
      column: first?.column,
      file: filePath,
      line: first?.line,
      message: `${basename(filePath)} has ${rejections.length} override(s) Blume can't plan:\n${rejections.map((rejection) => `  - ${rejection.message}`).join("\n")}`,
      severity: "error",
      suggestion: rejections.every((rejection) => rejection.missingFile)
        ? undefined
        : ACCEPTED_OVERRIDE_FORMS,
    },
    issues
  );
};

/**
 * Parse a user `components.ts`/`.tsx` and return its normalized overrides. Never
 * executes the file. Throws a `BLUME_COMPONENTS_INVALID`
 * {@link ComponentOverridesError} listing every entry that isn't one of the
 * accepted forms or points at a file that doesn't exist.
 */
export const analyzeComponentOverrides = (
  source: string,
  filePath: string
): ComponentOverrideAnalysis => {
  const result = emptyComponentOverrides();
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const exported = findDefaultExport(sourceFile);
  if (!exported) {
    throw invalidOverrides(filePath, sourceFile, [
      {
        message:
          "No default export was found; export `defineComponents({ mdx, layout })` (or a plain object literal) as the default.",
      },
    ]);
  }
  const object = unwrapObject(exported.expression);
  if (!object) {
    throw invalidOverrides(filePath, sourceFile, [
      {
        message:
          "The default export isn't an object literal or a `defineComponents({ ... })` call.",
        node: exported,
      },
    ]);
  }

  const context: AnalysisContext = {
    dir: dirname(filePath),
    errors: [],
    imports: collectImports(sourceFile),
    warnings: result.warnings,
  };

  for (const property of object.properties) {
    collectGroupOverrides(property, context, result);
  }

  if (context.errors.length > 0) {
    throw invalidOverrides(filePath, sourceFile, context.errors);
  }
  return result;
};
