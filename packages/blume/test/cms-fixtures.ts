import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type { JsonValue } from "../src/core/sources/json.ts";
import type { SourceContext } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";

/** Temp dirs a suite created; `cleanupTempDirs` removes them in `afterAll`. */
const dirs: string[] = [];

export const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `blume-${prefix}-`));
  dirs.push(dir);
  return dir;
};

export const cleanupTempDirs = async (): Promise<void> => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
};

export const ctxFor = (
  cacheDir: string,
  overrides: Partial<SourceContext> = {}
): SourceContext => ({
  cacheDir,
  mode: "build",
  projectRoot: cacheDir,
  ...overrides,
});

export const projectContext: ProjectContext = {
  componentsFile: null,
  configFile: null,
  contentRoot: "/p/docs",
  outDir: "/p/.blume",
  pagesRoot: null,
  root: "/p",
  themeFile: null,
};

/** One request the stub served. */
export interface RecordedCall {
  headers: Headers;
  url: URL;
}

type FetchHandler = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

// SAFETY: the sources call fetchImpl as a plain function; the preconnect
// helper Bun attaches to the real fetch is never accessed.
const asFetch = (handler: FetchHandler): typeof fetch =>
  handler as typeof fetch;

/** A recording fetch stub plus the calls it captured. */
export interface RecordingFetch {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
}

/**
 * A fetch stub answering each request from `respond`: a JSON value becomes a
 * 200 JSON body, a `Response` is returned as-is (for error statuses).
 */
export const recordingFetch = (
  respond: (call: RecordedCall) => JsonValue | Response
): RecordingFetch => {
  const calls: RecordedCall[] = [];
  const fetchImpl = asFetch((input, init) => {
    const call = {
      headers: new Headers(init?.headers),
      url: new URL(String(input)),
    };
    calls.push(call);
    const answer = respond(call);
    return Promise.resolve(
      answer instanceof Response ? answer : Response.json(answer)
    );
  });
  return { calls, fetchImpl };
};

/** Run `fn` with an env var set (or deleted, for `undefined`), then restore it. */
export const withEnv = async (
  key: string,
  value: string | undefined,
  fn: () => Promise<void>
): Promise<void> => {
  const saved = process.env[key];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = saved;
    }
  }
};
