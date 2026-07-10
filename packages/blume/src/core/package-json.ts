import { getBlumeVersion } from "./version.ts";

/**
 * Derive a valid npm package name from a directory name, falling back to
 * `docs` when nothing usable remains.
 */
export const toPackageName = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^[-_.]+|[-_.]+$/gu, "") || "docs";

/**
 * A minimal, runnable `package.json` body for a Blume project: the `blume`
 * dependency pinned to the installed version plus `dev`/`build`/`doctor`
 * scripts, so `npm install && npm run dev` works immediately. Shared by
 * `blume init` and the migrators, which scaffold one when a project has none.
 * `extraDeps` adds source SDKs (e.g. `@notionhq/client`) beside `blume`.
 */
export const blumePackageJson = (
  name: string,
  extraDeps: Record<string, string> = {}
): string => {
  const dependencies = Object.entries({
    blume: `^${getBlumeVersion()}`,
    ...extraDeps,
  })
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([dep, range]) => `    ${JSON.stringify(dep)}: ${JSON.stringify(range)}`
    )
    .join(",\n");
  return `{
  "name": ${JSON.stringify(name)},
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "blume dev",
    "build": "blume build",
    "doctor": "blume doctor"
  },
  "dependencies": {
${dependencies}
  }
}
`;
};
