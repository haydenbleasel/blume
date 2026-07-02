import { readFile } from "node:fs/promises";

import { normalize, upgrade } from "@scalar/openapi-parser";
import { isAbsolute, join } from "pathe";

import type { ApiDocument } from "./model.ts";

/**
 * Spec loading and normalization. Blume reuses Scalar's parser
 * (`@scalar/openapi-parser`) to read a spec (YAML or JSON), then upgrade Swagger
 * 2.0 / OpenAPI 3.0 documents to 3.1 so the renderer only handles one shape.
 * Internal `$ref`s are deliberately left in place (see `model.ts`).
 */

const URL_SPEC = /^https?:\/\//u;

export interface ParsedSpec {
  document: ApiDocument;
  warnings: string[];
}

/** Read a spec's raw text from an `http(s)` URL or a local (project-relative) path. */
const readSpecText = async (spec: string, root: string): Promise<string> => {
  if (URL_SPEC.test(spec)) {
    const response = await fetch(spec);
    if (!response.ok) {
      throw new Error(`${spec} -> ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }
  const absolute = isAbsolute(spec) ? spec : join(root, spec);
  return await readFile(absolute, "utf-8");
};

/**
 * Read, normalize, and upgrade a spec to an OpenAPI 3.1 document. Throws when the
 * spec can't be read; callers turn that into a source diagnostic rather than a
 * hard failure so a broken spec doesn't take down the whole build.
 */
export const parseSpec = async (
  spec: string,
  root: string
): Promise<ParsedSpec> => {
  const text = await readSpecText(spec, root);
  const normalized = normalize(text);
  const { specification } = upgrade(normalized);
  return { document: specification as ApiDocument, warnings: [] };
};
