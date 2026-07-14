import { existsSync, readFileSync } from "node:fs";

import { join } from "pathe";

import type { BlumeProject } from "../core/project-graph.ts";

/** Resolve a configured local SVG for use in generated Open Graph cards. */
export const resolveOgLogo = (
  project: BlumeProject,
  source: string | undefined
): string | undefined => {
  if (!source?.toLowerCase().endsWith(".svg")) {
    return;
  }
  const relative = source.replace(/^\//u, "");
  const file = [
    join(project.context.root, "public", relative),
    join(project.context.root, relative),
  ].find((path) => existsSync(path));
  return file ? readFileSync(file, "utf-8") : undefined;
};
