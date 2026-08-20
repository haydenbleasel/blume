/**
 * The Standard Schema interface (https://standardschema.dev), the minimal
 * `~standard` surface shared by Zod 3.24+, Zod 4, Valibot, ArkType, and
 * friends. Blume accepts user-supplied validation schemas (e.g.
 * `frontmatter.extend`) through this interface instead of Zod's own types:
 * `blume.config.ts` imports zod from the *consumer's* node_modules, which may
 * be a different major version than the zod Blume bundles, and calling Zod
 * methods (`.extend()`, `.safeParse()`) across instances is unsupported. The
 * `~standard.validate` contract is version- and library-agnostic.
 */

/** One validation failure, with an optional path into the checked value. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

/** A passing validation: the (possibly transformed) output value. */
export interface StandardSchemaSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

/** A failing validation: one or more issues. */
export interface StandardSchemaFailure {
  readonly issues: readonly StandardSchemaIssue[];
}

export type StandardSchemaResult<Output> =
  | StandardSchemaSuccess<Output>
  | StandardSchemaFailure;

/** A validation schema exposing the Standard Schema `~standard` contract. */
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: Input
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}

/**
 * Whether a config-supplied value implements the `~standard` contract. Generic
 * so it can decode any input at the config boundary (`z.custom` hands it the
 * raw config value) while narrowing whatever type the caller holds.
 */
export const isStandardSchema = <T>(value: T): value is T & StandardSchema =>
  typeof value === "object" &&
  value !== null &&
  // SAFETY: the assertion only widens the checked object for property probing;
  // the trailing typeof check is what verifies `~standard.validate` exists.
  typeof (value as { "~standard"?: { validate?: unknown } })["~standard"]
    ?.validate === "function";
