import { readFile } from "node:fs/promises";

import { load } from "js-yaml";
import { z } from "zod";

/** Question ids are kebab-case slugs so they read well in reports and CI logs. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

const questionSchema = z.strictObject({
  expected: z
    .array(z.string().min(1))
    .min(1, "expected must list at least one fact"),
  id: z
    .string()
    .regex(ID_PATTERN, "id must be a kebab-case slug (a-z, 0-9, dashes)"),
  question: z.string().min(1),
  routes: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((value) => (Array.isArray(value) ? value : [value])),
  severity: z.enum(["error", "warning"]).default("error"),
  skip: z.boolean().default(false),
});

/** One author-written eval: a question plus the facts a passing answer states. */
export type EvalQuestion = z.infer<typeof questionSchema>;

const fullSchema = z.strictObject({
  questions: z.array(questionSchema).min(1),
  version: z.literal(1).default(1),
});

/**
 * The evals file schema. A bare top-level list of questions is accepted as
 * shorthand — `loadEvalsFile` wraps it before validating, rather than a
 * `z.union`, so schema errors name the offending field instead of collapsing
 * into an opaque "invalid union" issue.
 */
export const evalsFileSchema = fullSchema.superRefine((value, context) => {
  const seen = new Set<string>();
  for (const question of value.questions) {
    if (seen.has(question.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate question id "${question.id}"`,
        path: ["questions"],
      });
    }
    seen.add(question.id);
  }
});

export type EvalsFile = z.infer<typeof evalsFileSchema>;

/** A problem loading or validating the evals file, with the path it names. */
export class EvalsFileError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "EvalsFileError";
    this.path = path;
  }
}

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      return `${issue.message}${at}`;
    })
    .join("; ");

/**
 * Read and validate an evals file. Returns the parsed questions plus the raw
 * text, kept so findings can anchor to the line a question is defined on.
 */
export const loadEvalsFile = async (
  path: string
): Promise<{ evals: EvalsFile; raw: string }> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    throw new EvalsFileError(
      path,
      `No evals file found at ${path}. Run \`blume eval init\` to draft one.`
    );
  }

  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvalsFileError(path, `Invalid YAML in ${path}: ${detail}`);
  }

  // The bare-list shorthand: a top-level sequence of questions.
  const candidate = Array.isArray(parsed) ? { questions: parsed } : parsed;
  const result = evalsFileSchema.safeParse(candidate);
  if (!result.success) {
    throw new EvalsFileError(
      path,
      `Invalid evals file at ${path}: ${describeIssues(result.error)}`
    );
  }
  return { evals: result.data, raw };
};

/**
 * The 1-based line where a question's `id:` entry appears in the raw evals
 * file, so a finding with no route hint can still point somewhere editable.
 */
export const locateQuestion = (raw: string, id: string): number | undefined => {
  const pattern = new RegExp(`^\\s*-?\\s*id:\\s*["']?${id}["']?\\s*$`, "u");
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      return index + 1;
    }
  }
  return undefined;
};
