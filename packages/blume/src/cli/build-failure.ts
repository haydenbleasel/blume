import { z } from "zod";

import type { Diagnostic } from "../core/types.ts";

/**
 * The fields of an `astro build` rejection the report reads. Rolldown bundles
 * every plugin failure (an MDX compile error, say) into one error whose
 * `errors` holds each; a failure carries `loc` where the compiler pinned it,
 * or only `id`, the module that failed.
 */
const buildErrorSchema = z.looseObject({
  errors: z.array(z.instanceof(Error)).optional(),
  id: z.string().optional(),
  loc: z
    .looseObject({
      column: z.number().optional(),
      file: z.string().optional(),
      line: z.number().optional(),
    })
    .optional(),
});

/**
 * The diagnostic a `BlumeError` thrown inside the build carries, such as a
 * failed hosted search sync in `astro:build:done`. The hook runs Blume's
 * source rather than the CLI bundle, so its error is another copy of the class
 * that the command's `instanceof BlumeError` doesn't recognize.
 */
const blumeErrorSchema = z.looseObject({
  diagnostic: z.object({
    code: z.string(),
    column: z.number().optional(),
    docsUrl: z.string().optional(),
    file: z.string().optional(),
    line: z.number().optional(),
    message: z.string(),
    severity: z.enum(["error", "info", "warning"]),
    suggestion: z.string().optional(),
  }),
});

/** One failure as a diagnostic at the file (and position) it names. */
const failureDiagnostic = (error: Error): Diagnostic => {
  const raised = blumeErrorSchema.safeParse(error);
  if (raised.success) {
    return raised.data.diagnostic;
  }
  const parsed = buildErrorSchema.safeParse(error);
  const { id, loc } = parsed.success ? parsed.data : {};
  // A named error (`MDXError`, `CompilerError`) says which step failed.
  const name = error.name === "Error" ? "" : `${error.name}: `;
  return {
    code: "BLUME_BUILD_FAILED",
    column: loc?.column,
    file: loc?.file ?? id,
    line: loc?.line,
    message: `${name}${error.message}`,
    severity: "error",
  };
};

/**
 * What `astro build` rejected with, as build diagnostics: one per failure
 * Rolldown collected, else the error itself. A page Blume's own checks pass
 * can still fail Astro's compile (MDX that doesn't parse) or render, and that
 * is a problem in the site, reported at its file, rather than an internal
 * error blaming Blume.
 */
export const astroBuildDiagnostics = (error: Error): Diagnostic[] => {
  const parsed = buildErrorSchema.safeParse(error);
  const failures = parsed.success ? (parsed.data.errors ?? []) : [];
  return (failures.length > 0 ? failures : [error]).map(failureDiagnostic);
};
