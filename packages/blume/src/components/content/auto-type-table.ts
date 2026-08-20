/**
 * TypeScript type extraction for `<AutoTypeTable>`.
 *
 * Reads an interface or type alias — from a file path or inline source — via the
 * TypeScript compiler API and returns one row per property: the shape
 * `<TypeTable>` renders. `typescript` is loaded lazily (dynamic import) so the
 * dependency is only pulled into the build when a page actually uses
 * `<AutoTypeTable>`.
 */
import nodePath from "node:path";

import type {
  CompilerHost,
  CompilerOptions,
  DeclarationStatement,
  Program,
} from "typescript";

// `typeof import(...)` is the only way to name the whole lazily-imported
// `typescript` module without a value import (see components/props.ts).
// oxlint-disable-next-line typescript/consistent-type-imports
type TypeScriptApi = typeof import("typescript");

/** A single documented property — one generated row of a type table. */
export interface TypeTableProperty {
  default?: string;
  description?: string;
  name: string;
  required: boolean;
  type: string;
}

export interface ExtractOptions {
  /** Named interface or type alias to document. */
  name: string;
  /** File to read the type from, resolved relative to {@link ExtractOptions.root}. */
  path?: string;
  /** Base directory for resolving a relative {@link ExtractOptions.path}. */
  root?: string;
  /** Inline TypeScript source. Used when {@link ExtractOptions.path} is omitted. */
  source?: string;
}

/** Virtual file name backing the in-memory program when `source` is supplied. */
const VIRTUAL_FILE = "__blume_auto_type_table__.ts";

/** Build a compiler host that serves a single in-memory file plus the real libs. */
const inMemoryHost = (
  ts: TypeScriptApi,
  options: CompilerOptions,
  source: string
): CompilerHost => {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreate) =>
    requested === VIRTUAL_FILE
      ? ts.createSourceFile(VIRTUAL_FILE, source, languageVersion, true)
      : getSourceFile(requested, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (requested) =>
    requested === VIRTUAL_FILE || fileExists(requested);
  const readFile = host.readFile.bind(host);
  host.readFile = (requested) =>
    requested === VIRTUAL_FILE ? source : readFile(requested);
  return host;
};

/**
 * Extract the documented properties of `name` from a TypeScript file or inline
 * source. Property rows carry the declared type text, JSDoc description,
 * `@default` tag, and whether the property is required.
 */
export const extractTypeTable = async (
  options: ExtractOptions
): Promise<TypeTableProperty[]> => {
  const { name, path, root = process.cwd(), source } = options;
  const tsModule = await import("typescript");
  // SAFETY: CJS/ESM interop — the typescript package exposes its API namespace
  // either directly or under `default` depending on the loader; both are the
  // same object, which TypeScriptApi models structurally.
  const ts = (tsModule.default ?? tsModule) as TypeScriptApi;

  const compilerOptions: CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };

  let fileName: string;
  let program: Program;
  if (source === undefined) {
    if (path === undefined) {
      throw new Error("AutoTypeTable needs a `path` or inline `type` source.");
    }
    fileName = nodePath.isAbsolute(path) ? path : nodePath.join(root, path);
    program = ts.createProgram([fileName], compilerOptions);
  } else {
    fileName = VIRTUAL_FILE;
    program = ts.createProgram(
      [fileName],
      compilerOptions,
      inMemoryHost(ts, compilerOptions, source)
    );
  }

  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error(`Could not read "${path ?? VIRTUAL_FILE}".`);
  }

  const declaration = sourceFile.statements.find(
    (statement): statement is DeclarationStatement =>
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name?.text === name
  );
  if (!declaration) {
    throw new Error(`No interface or type named "${name}" found.`);
  }

  const checker = program.getTypeChecker();
  const type = checker.getTypeAtLocation(declaration);

  return checker.getPropertiesOfType(type).map((symbol) => {
    const decl = symbol.declarations?.[0];
    const signature = decl && ts.isPropertySignature(decl) ? decl : undefined;
    const typeText = signature?.type
      ? signature.type.getText(sourceFile)
      : checker.typeToString(
          checker.getTypeOfSymbolAtLocation(symbol, decl ?? declaration)
        );
    const description = ts
      .displayPartsToString(symbol.getDocumentationComment(checker))
      .trim();
    const defaultTag = symbol
      .getJsDocTags(checker)
      .find((tag) => tag.name === "default" || tag.name === "defaultValue");
    const defaultValue = defaultTag
      ? ts.displayPartsToString(defaultTag.text).trim()
      : "";

    return {
      default: defaultValue || undefined,
      description: description || undefined,
      name: symbol.getName(),
      // Optionality lives on the checker's symbol, not the backing
      // declaration: mapped/utility types synthesize members whose
      // declaration has no question token (`Partial<Base>` would read as
      // all-required), and `Required<Base>` strips optionality while the
      // declaration keeps its `?` — the token is wrong in both directions.
      // oxlint-disable-next-line no-bitwise -- SymbolFlags is a bitfield
      required: (symbol.flags & ts.SymbolFlags.Optional) === 0,
      type: typeText,
    };
  });
};
