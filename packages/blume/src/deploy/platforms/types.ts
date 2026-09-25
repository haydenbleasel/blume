import type { JsonValue } from "../../core/adapter.ts";
import type { BlumeProject } from "../../core/project-graph.ts";
import type { ResolvedConfig } from "../../core/schema.ts";
import type { ProjectContext } from "../../core/types.ts";
import type { DeployAdapterKind } from "../adapters/registry.ts";
import type { DeployOutput } from "../adapters/types.ts";

/**
 * Everything Blume does differently per deployment target, keyed by the
 * descriptor's `kind`. The descriptor a `blume/deploy` factory returns is
 * plain data (it is inlined into the generated project), so the behavior
 * lives here, one module per adapter, and every consumer reads it through
 * `deployPlatform()` instead of switching on an adapter name.
 */

/** How the generated `astro.config.mjs` constructs the `@astrojs/*` adapter. */
export interface AstroAdapterSpec {
  /** Top-level `defineConfig` entries the adapter needs beside itself. */
  config: Record<string, JsonValue>;
  /** Blume's own constructor options; the user's passthrough is spread over them. */
  options: (context: ProjectContext) => Record<string, JsonValue>;
  /** The package the config imports the adapter from. */
  package: string;
}

/** Platform env detection, for inferring `site` and the audit's wording. */
export interface PlatformEnv {
  /** True when the env says the build is running on this platform. */
  detect: (env: NodeJS.ProcessEnv) => boolean;
  /** The canonical site URL from the platform's env vars, or null. */
  site: (env: NodeJS.ProcessEnv) => string | null;
}

type Redirect = ResolvedConfig["redirects"][number];

/** A redirect file a static build writes for the host to read. */
export interface RedirectFile {
  build: (redirects: Redirect[]) => string;
  name: string;
}

/** The log surface a post-build step reports through (the CLI's logger). */
export interface BuildLog {
  error: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

export interface FinalizeBuildOptions {
  /** A `blume build --isolated` verify: check the output, publish nothing. */
  isolated: boolean;
  log: BuildLog;
  project: BlumeProject;
}

/**
 * What exists only because the Astro project lives in the hidden `.blume/`
 * runtime instead of the project root. RFC #114 (integration-first) puts the
 * Astro project at the root, after which this whole group goes: the platform
 * then reads its bundle where the adapter wrote it, and the adapter sees the
 * real root without being told.
 */
export interface HiddenRuntime {
  /**
   * The top-level directory the adapter's deploy bundle lands in, for
   * `.gitignore`. The platform's own state lives beside the bundle
   * (`.vercel/project.json`, `.netlify/state.json`), so the directory is
   * ignored whole. Null when the bundle lands in `dist/`, already ignored.
   */
  ignoreDir: string | null;
  /**
   * Hand the adapter the project root (`withAdapterRoot`) instead of the
   * runtime: for an adapter that resolves its output tree, or a dependency
   * trace, against `root`, which for Blume is the hidden runtime.
   */
  showProjectRoot: boolean;
  /**
   * A bundle written relative to the Astro root, to move from
   * `<root>/.blume/<path>` up to `<root>/<path>` after the build, where the
   * platform looks for it. Null when nothing needs moving.
   */
  surfacePath: string | null;
}

export interface DeployPlatform {
  /** The `@astrojs/*` adapter a server build uses; null for the static kind. */
  astro: AstroAdapterSpec | null;
  /** Env detection, or null for a target with no platform env (Node, static). */
  env: PlatformEnv | null;
  /**
   * The post-build step for a server build — Vercel's function-bundle audit
   * and negotiation routes, Cloudflare's wrapper Worker. Resolves to false
   * when the build must not ship.
   */
  finalizeBuild: ((options: FinalizeBuildOptions) => Promise<boolean>) | null;
  hiddenRuntime: HiddenRuntime;
  kind: DeployAdapterKind;
  /** Whether a server build honors `Accept: text/markdown` at the content URLs. */
  negotiatesMarkdown: boolean;
  /**
   * The host CLI command that deploys a preview, for a platform whose
   * `@astrojs/*` adapter has no local preview server: Astro's `preview`
   * throws for its server build, so `blume preview` points here instead. Null
   * when the adapter can preview a server build locally, or there is none.
   */
  previewDeploy: string | null;
  /**
   * Whether the platform applies a `_headers` file to the static assets it
   * serves, per output mode.
   */
  readsHeaderFiles: Record<DeployOutput, boolean>;
  /** The redirect files a static build writes, beside the manifest. */
  redirectFiles: RedirectFile[];
  /**
   * Whether the adapter moves a server build's client output under
   * `deployment.base` (`dist/client/<base>/`, the directory Astro then hands
   * `astro:build:done`) while the platform keeps serving `serverStaticDir`
   * as the assets root. The files the platform reads there, like `_headers`,
   * belong above the directory Astro reports.
   */
  serverClientUnderBase: boolean;
  /** Where a server build's deploy bundle lands. */
  serverOutputDir: (context: ProjectContext) => string;
  /** The directory a server build serves as static files. */
  serverStaticDir: (context: ProjectContext) => string;
}
