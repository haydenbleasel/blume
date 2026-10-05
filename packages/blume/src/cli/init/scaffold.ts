import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { loadAll } from "js-yaml";
import { detect } from "package-manager-detector/detect";
import { basename, dirname, isAbsolute, join, relative } from "pathe";
import picomatch from "picomatch";
import { z } from "zod";

import { blumePackageJson, toPackageName } from "../../core/package-json.ts";
import { contentful } from "../../sources/contentful.ts";
import { githubReleases } from "../../sources/github-releases.ts";
import { mdxRemote } from "../../sources/mdx-remote.ts";
import { notion } from "../../sources/notion.ts";
import { obsidian } from "../../sources/obsidian.ts";
import { payload } from "../../sources/payload.ts";
import type { AnySourceAdapter } from "../../sources/registry.ts";
import { sanity } from "../../sources/sanity.ts";
import { strapi } from "../../sources/strapi.ts";
import { STARTER_OPENAPI_JSON } from "./starter-spec.ts";

export const TEMPLATES = ["docs", "api", "sdk", "changelog"] as const;
export type Template = (typeof TEMPLATES)[number];

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** The content-source kinds `init` can scaffold a config block for. */
export const SOURCE_KINDS = [
  "filesystem",
  "obsidian",
  "github-releases",
  "notion",
  "sanity",
  "contentful",
  "payload",
  "strapi",
  "mdx-remote",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Everything the scaffolder needs, whether prompted or derived from flags. */
export interface InitAnswers {
  contentDir: string;
  /** Target directory as the user gave it (`.` = current directory). */
  directory: string;
  packageManager: PackageManager;
  sources: SourceKind[];
  template: Template;
  title: string;
}

/** One file the scaffold plan will write; `path` is absolute. */
export interface ScaffoldFile {
  content: string;
  path: string;
}

/** Log sink for scaffold output — satisfied by both consola and clack's `log`. */
export interface ScaffoldLog {
  info: (message: string) => void;
  success: (message: string) => void;
}

/** A starter: a config fragment plus seed content files (paths relative to root). */
interface Starter {
  configExtra: string;
  /** Import lines the fragment needs, placed after the `defineConfig` import. */
  configImports: string[];
  files: (contentDir: string) => { content: string; path: string }[];
  /**
   * Files the config itself reads (the `api` starter's spec), written beside
   * it whichever content sources are selected.
   */
  projectFiles?: { content: string; path: string }[];
}

const page = (title: string, description: string, body: string): string =>
  `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`;

export const STARTERS = {
  api: {
    configExtra: `
  reference: [
    openapi({
      route: "/api",
      sources: [
        {
          label: "Pet Store",
          spec: "./openapi.json",
        },
      ],
    }),
  ],`,
    configImports: ['import { openapi } from "blume/reference";'],
    files: (dir) => [
      {
        content: page(
          "API Reference",
          "Reference documentation for the API, generated from its OpenAPI spec, with every endpoint, its parameters, request bodies, and responses.",
          "The example spec in `openapi.json` renders at [`/api`](/api). Replace it with your own, or point `openapi()` at your spec in `blume.config.ts`."
        ),
        path: join(dir, "index.mdx"),
      },
    ],
    projectFiles: [{ content: STARTER_OPENAPI_JSON, path: "openapi.json" }],
  },
  changelog: {
    configExtra: `
  navigation: {
    tabs: [
      { label: "Docs", path: "/" },
      { label: "Changelog", path: "/changelog" },
    ],
  },`,
    configImports: [],
    files: (dir) => [
      {
        content: page(
          "Introduction",
          "Welcome to your new documentation site. Write guides as Markdown pages here, and log each release as an entry in the changelog folder.",
          "Write your docs here, and log releases under `changelog/`: each entry joins the [changelog](/changelog), newest first."
        ),
        path: join(dir, "index.mdx"),
      },
      {
        content: `---\ntitle: v1.0.0\ndescription: The first release of the project. Replace this entry with your own release notes, and add a new file beside it for every version.\ntype: changelog\ndate: 2026-01-01\n---\n\nThe first release. Edit \`${dir}/changelog/v1-0-0.mdx\` or add new entries beside it.\n`,
        path: join(dir, "changelog", "v1-0-0.mdx"),
      },
    ],
  },
  docs: {
    configExtra: "",
    configImports: [],
    files: (dir) => [
      {
        content: page(
          "Introduction",
          "Welcome to your new documentation site. Edit this page or add Markdown files beside it, and Blume turns each file into a page.",
          `Welcome to **Blume**, the open-source docs framework for humans and agents.\n\nEdit \`${dir}/index.mdx\` and save: this page reloads with your changes.`
        ),
        path: join(dir, "index.mdx"),
      },
    ],
  },
  sdk: {
    configExtra: "",
    configImports: [],
    files: (dir) => [
      {
        content: page(
          "Introduction",
          "Get started with the SDK. Install the package, configure a client, and make your first call in a few lines of code in your own app.",
          "Install the SDK and make your first call. See [Installation](/installation)."
        ),
        path: join(dir, "index.mdx"),
      },
      {
        content: page(
          "Installation",
          "Install the SDK with the package manager your project already uses, then import it into your code to start making requests to the API.",
          "```package-install\nyour-sdk\n```"
        ),
        path: join(dir, "installation.mdx"),
      },
    ],
  },
} satisfies Record<Template, Starter>;

/**
 * Add, install, and dev commands to print for the chosen package manager, plus the
 * prefix that runs a locally installed bin (`exec`, e.g. `npx blume eject`) —
 * dependency bins aren't on PATH, so a bare `blume …` hint would not run.
 */
export const commandsFor = (pm: PackageManager) => ({
  // Adds a dependency: npm spells the verb `install`, the others `add`.
  add: pm === "npm" ? "npm install" : `${pm} add`,
  // `bun build` invokes Bun's bundler, not the package.json `build` script —
  // unlike `bun dev`, the script name is shadowed by a builtin subcommand.
  build: pm === "npm" || pm === "bun" ? `${pm} run build` : `${pm} build`,
  dev: pm === "npm" ? "npm run dev" : `${pm} dev`,
  exec: { bun: "bunx", npm: "npx", pnpm: "pnpm exec", yarn: "yarn" }[pm],
  install: `${pm} install`,
});

// A path every shell (POSIX, cmd, PowerShell) takes as one bare word.
const SHELL_SAFE_PATH = /^[\w./:-]+$/u;
// What a double-quoted POSIX word still interprets.
const DOUBLE_QUOTE_SPECIAL = /["$\\`]/gu;

/**
 * The `cd` into the new project, quoting a directory a shell would split or
 * expand: `blume init "my docs"` prints `cd "my docs"`, not `cd my docs`.
 */
export const cdCommand = (directory: string): string =>
  SHELL_SAFE_PATH.test(directory)
    ? `cd ${directory}`
    : `cd "${directory.replaceAll(DOUBLE_QUOTE_SPECIAL, String.raw`\$&`)}"`;

const isPackageManager = (value: string): value is PackageManager =>
  PACKAGE_MANAGERS.some((pm) => pm === value);

/**
 * Derive the package manager from an npm user-agent string (the first
 * `name/version` token of `npm_config_user_agent`), falling back to npm.
 * Right for `init`, where the project doesn't exist yet and the invoking
 * runner is the only signal.
 */
export const detectPackageManager = (userAgent?: string): PackageManager => {
  const name = userAgent?.split("/")[0];
  return name !== undefined && isPackageManager(name) ? name : "npm";
};

/**
 * The nearest directory at or above `root` holding `.git` (a directory, or
 * the file a worktree or submodule carries), or null outside a repository.
 * Checked by presence rather than by asking git, so no path spelling is ever
 * compared: git prints its toplevel with symlinks and Windows 8.3 short
 * names resolved, which nothing in Node canonicalizes to.
 */
const repositoryRootOf = (root: string): string | null => {
  let dir = root;
  while (!existsSync(join(dir, ".git"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return dir;
};

/**
 * Detect an existing project's package manager from its lockfile /
 * `packageManager` field (package-manager-detector), falling back to the
 * user agent. Right for `eject`: the CLI is often run directly (`npx blume
 * eject`, a bare `blume eject`), where `npm_config_user_agent` is absent or
 * names the runner rather than the project's manager, and the old
 * user-agent-only detection silently printed npm hints for a pnpm project.
 */
export const detectProjectPackageManager = async (
  root: string
): Promise<PackageManager> => {
  // A workspace package keeps its lockfile and `packageManager` field at the
  // repository root, so the walk climbs that far — but no further, or a
  // `package.json` in an unrelated ancestor (a user's home directory, say)
  // decides the project's commands. Outside a repository the project root is
  // the only directory that can be trusted.
  const detected = await detect({
    cwd: root,
    stopDir: repositoryRootOf(root) ?? root,
  });
  const name = detected?.name;
  return name !== undefined && isPackageManager(name)
    ? name
    : detectPackageManager(process.env.npm_config_user_agent);
};

/**
 * The content dir is joined into every scaffolded file path, so an absolute or
 * `../`-escaping value would write outside the project. Returns an error
 * message, or `undefined` when the dir is safe.
 */
export const validateContentDir = (
  root: string,
  dir: string
): string | undefined =>
  isAbsolute(dir) || relative(root, join(root, dir)).startsWith("..")
    ? "Must be a relative path inside the project."
    : undefined;

/** Turn a directory name into a display title: `my-docs` → `My Docs`. */
export const titleize = (raw: string): string => {
  const words = raw
    .replaceAll(/[-_.]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  return words.length === 0
    ? "My Docs"
    : words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
};

/**
 * True when any selected source needs an explicit `content.sources` array —
 * everything except `filesystem`, which is what the implicit default already
 * desugars to.
 */
const needsExplicitSources = (sources: SourceKind[]): boolean =>
  sources.some((source) => source !== "filesystem");

/** The `blume/sources` factory each source kind is written with. */
const SOURCE_FACTORIES = {
  contentful: "contentful",
  filesystem: "filesystem",
  "github-releases": "githubReleases",
  "mdx-remote": "mdxRemote",
  notion: "notion",
  obsidian: "obsidian",
  payload: "payload",
  sanity: "sanity",
  strapi: "strapi",
} satisfies Record<SourceKind, string>;

/**
 * The descriptor each remote source kind scaffolds — the same placeholder
 * options the emitted snippet shows — so the SDK deps and env vars `init`
 * sets up are read off the adapter rather than kept in a parallel table.
 */
const SOURCE_DESCRIPTORS = {
  contentful: contentful({
    contentType: "doc",
    prefix: "contentful",
    space: "your-space-id",
  }),
  "github-releases": githubReleases({
    owner: "your-org",
    prefix: "changelog",
    repo: "your-repo",
  }),
  "mdx-remote": mdxRemote({
    github: { owner: "your-org", path: "docs", repo: "your-repo" },
    prefix: "remote",
  }),
  notion: notion({ database: "your-database-id", prefix: "notion" }),
  obsidian: obsidian({ prefix: "notes", vault: "vault" }),
  payload: payload({
    collection: "docs",
    prefix: "payload",
    url: "https://cms.example.com",
  }),
  sanity: sanity({
    dataset: "production",
    prefix: "sanity",
    projectId: "your-project-id",
    query: '*[_type == "doc"]',
  }),
  strapi: strapi({
    contentType: "docs",
    prefix: "strapi",
    url: "https://cms.example.com",
  }),
} satisfies Record<Exclude<SourceKind, "filesystem">, AnySourceAdapter>;

/**
 * Config snippets for each remote source kind, with placeholder values to
 * replace and comments naming the env var each source authenticates with.
 */
const SOURCE_SNIPPETS = {
  contentful: `      // Entries of a Contentful content type. Reads CONTENTFUL_ACCESS_TOKEN
      // from the environment.
      contentful({
        space: "your-space-id",
        contentType: "doc",
        prefix: "contentful",
      }),`,
  "github-releases": `      // Changelog entries from GitHub Releases. Private repos read
      // GITHUB_TOKEN from the environment.
      githubReleases({
        owner: "your-org",
        repo: "your-repo",
        prefix: "changelog",
      }),`,
  "mdx-remote": `      // MDX fetched from a GitHub repo. Private repos read GITHUB_TOKEN
      // from the environment.
      mdxRemote({
        github: { owner: "your-org", repo: "your-repo", path: "docs" },
        prefix: "remote",
      }),`,
  notion: `      // Pages from a Notion database. Reads NOTION_TOKEN from the environment.
      notion({
        database: "your-database-id",
        prefix: "notion",
      }),`,
  obsidian: `      // An Obsidian vault, read in place. No export step, and no
      // generated notes in your repo. Point \`vault\` at your vault directory,
      // relative to this config file.
      obsidian({
        vault: "vault",
        prefix: "notes",
      }),`,
  payload: `      // Documents from a Payload collection. Reads PAYLOAD_API_KEY from
      // the environment.
      payload({
        url: "https://cms.example.com",
        collection: "docs",
        prefix: "payload",
      }),`,
  sanity: `      // Documents from a Sanity dataset. Private datasets read SANITY_TOKEN
      // from the environment.
      sanity({
        projectId: "your-project-id",
        dataset: "production",
        query: \`*[_type == "doc"]\`,
        prefix: "sanity",
      }),`,
  strapi: `      // Entries of a Strapi content type. Reads STRAPI_API_TOKEN from
      // the environment.
      strapi({
        url: "https://cms.example.com",
        contentType: "docs",
        prefix: "strapi",
      }),`,
} satisfies Record<Exclude<SourceKind, "filesystem">, string>;

/** The selected kinds in canonical order (the multiselect returns pick order). */
const orderedSources = (sources: SourceKind[]): SourceKind[] =>
  SOURCE_KINDS.filter((kind) => sources.includes(kind));

/** The `blume/sources` import line for the selected kinds, in canonical order. */
const sourcesImportFor = (sources: SourceKind[]): string =>
  `import { ${orderedSources(sources)
    .map((kind) => SOURCE_FACTORIES[kind])
    .join(", ")} } from "blume/sources";\n`;

/** The chosen source kinds; no selection means the implicit local source. */
const selectedSources = (answers: InitAnswers): SourceKind[] =>
  answers.sources.length === 0 ? ["filesystem"] : answers.sources;

/**
 * The `content` block for the generated config, or an empty string when the
 * defaults (filesystem source, `docs` root) apply — keeping the default
 * scaffold byte-identical to a config with no `content` key at all.
 */
const contentBlockFor = (answers: InitAnswers): string => {
  const sources = selectedSources(answers);
  if (!needsExplicitSources(sources)) {
    return answers.contentDir === "docs"
      ? ""
      : `
  content: {
    root: ${JSON.stringify(answers.contentDir)},
  },`;
  }
  // Explicit sources replace the implicit filesystem desugar, so the local
  // content dir must be listed alongside the other sources to stay included.
  const entries = orderedSources(sources).map((kind) =>
    kind === "filesystem"
      ? `      filesystem({ root: ${JSON.stringify(answers.contentDir)} }),`
      : SOURCE_SNIPPETS[kind]
  );
  return `
  content: {
    sources: [
${entries.join("\n")}
    ],
  },`;
};

/** The full `blume.config.ts` text for the chosen answers. */
export const buildConfig = (answers: InitAnswers): string => {
  const starter = STARTERS[answers.template];
  const sources = selectedSources(answers);
  // Only an explicit `sources` array calls factories; the shorthand `root`
  // (or no content block at all) needs no import.
  const sourcesImport = needsExplicitSources(sources)
    ? sourcesImportFor(sources)
    : "";
  const imports = [
    'import { defineConfig } from "blume";',
    ...starter.configImports,
  ].join("\n");
  return `${imports}
${sourcesImport}
export default defineConfig({
  title: ${JSON.stringify(answers.title)},
  description: "Documentation powered by Blume.",${starter.configExtra}${contentBlockFor(answers)}
});
`;
};

/** The version range `init` pins for each SDK an adapter declares. */
const SDK_VERSIONS = new Map([
  ["@notionhq/client", "^5.26.0"],
  ["@sanity/client", "^8.6.1"],
]);

/** The scaffolded descriptors for the selected remote source kinds. */
const descriptorsFor = (sources: SourceKind[]): AnySourceAdapter[] =>
  orderedSources(sources).flatMap((kind) =>
    kind === "filesystem" ? [] : [SOURCE_DESCRIPTORS[kind]]
  );

/** SDK dependencies the selected sources declare, read off their descriptors. */
const extraDepsFor = (sources: SourceKind[]) => {
  const deps: Record<string, string> = {};
  for (const descriptor of descriptorsFor(sources)) {
    for (const dep of descriptor.runtimeDeps) {
      deps[dep] = SDK_VERSIONS.get(dep) ?? "latest";
    }
  }
  return deps;
};

/**
 * `pnpm-workspace.yaml` for a new pnpm project. pnpm runs a dependency's
 * build script only once it's approved, and fails the install over any it
 * wasn't told about. esbuild's postinstall checks its platform binary;
 * `@scarf/scarf` is a telemetry postinstall a transitive dependency pulls in,
 * and Blume doesn't need it to run.
 */
const PNPM_WORKSPACE = `allowBuilds:
  esbuild: true
  "@scarf/scarf": false
`;

/**
 * `.yarnrc.yml` for a new Yarn Berry project. Berry installs with Plug'n'Play
 * by default, which writes no `node_modules`; Blume's generated Astro project
 * resolves its packages from one. Yarn Classic never reads this file.
 */
const YARNRC = `# Blume's generated Astro project resolves packages from node_modules, which
# Yarn's default Plug'n'Play install doesn't create.
nodeLinker: node-modules
`;

/**
 * The nearest directory at or above `root` where `found` holds, searching up
 * to the repository root — or to the filesystem root outside a repository,
 * where a workspace can still enclose the project.
 */
const nearestAncestor = (
  root: string,
  found: (dir: string) => boolean
): string | null => {
  const stop = repositoryRootOf(root);
  let dir = root;
  while (!found(dir)) {
    const parent = dirname(dir);
    if (dir === stop || parent === dir) {
      return null;
    }
    dir = parent;
  }
  return dir;
};

/** Read a file, or `""` when it can't be read. */
const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
};

/** The pnpm workspace enclosing `root`: the directory of its `pnpm-workspace.yaml`. */
const pnpmWorkspaceRoot = (root: string): string | null =>
  nearestAncestor(root, (dir) => existsSync(join(dir, "pnpm-workspace.yaml")));

/** The slice of `pnpm-workspace.yaml` the membership check reads. */
const pnpmWorkspaceSchema = z.looseObject({
  packages: z.array(z.string()).default([]),
});

// A glob's leading `./` and trailing `/`, which pnpm ignores.
const GLOB_EDGES = /^\.\/|\/+$/gu;

const globPattern = (glob: string): string => glob.replaceAll(GLOB_EDGES, "");

/** Whether any of `globs` matches the workspace-relative path `at`. */
const matchesAny = (globs: string[], at: string): boolean =>
  globs.length > 0 && picomatch(globs)(at);

/**
 * Whether the pnpm workspace at `workspace` lists `root` as one of its
 * packages: the workspace root itself, or a folder its `packages` globs match
 * and no `!` glob excludes. pnpm installs only those, so an install run in any
 * other folder beneath it succeeds without installing that folder's
 * dependencies. A workspace file that doesn't parse counts as listing it, so
 * `init` never claims what it can't tell.
 */
const listsPackage = (workspace: string, root: string): boolean => {
  const at = relative(workspace, root);
  if (at === "") {
    return true;
  }
  let parsed: ReturnType<typeof pnpmWorkspaceSchema.safeParse>;
  try {
    // `loadAll`, not `load`: js-yaml 5 throws on a file with no document (empty,
    // or comments only), which pnpm reads as a workspace of the root alone.
    const [document] = loadAll(
      readText(join(workspace, "pnpm-workspace.yaml"))
    );
    parsed = pnpmWorkspaceSchema.safeParse(document ?? {});
  } catch {
    return true;
  }
  if (!parsed.success) {
    return true;
  }
  const globs = parsed.data.packages;
  const included = globs
    .filter((glob) => !glob.startsWith("!"))
    .map(globPattern);
  const excluded = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => globPattern(glob.slice(1)));
  return matchesAny(included, at) && !matchesAny(excluded, at);
};

/**
 * Whether `init` installs with pnpm into a folder that sits inside a pnpm
 * workspace without being one of its packages. pnpm would install that
 * workspace's own packages from there and exit 0, leaving `blume` uninstalled.
 */
export const outsidePnpmWorkspace = (
  root: string,
  answers: InitAnswers
): boolean => {
  if (answers.packageManager !== "pnpm") {
    return false;
  }
  const workspace = pnpmWorkspaceRoot(root);
  return workspace !== null && !listsPackage(workspace, root);
};

/**
 * The Yarn project enclosing `root`: a directory holding a lockfile, a
 * `.yarnrc.yml`, or a `package.json` that declares workspaces.
 */
const yarnProjectRoot = (root: string): string | null =>
  nearestAncestor(
    root,
    (dir) =>
      existsSync(join(dir, "yarn.lock")) ||
      existsSync(join(dir, ".yarnrc.yml")) ||
      /"workspaces"\s*:/u.test(readText(join(dir, "package.json")))
  );

/**
 * The major version of the Yarn that ran `init`, read off the npm user agent
 * (`yarn/4.5.1 npm/? node/v22…`), or undefined when something else ran it.
 */
export const yarnMajor = (userAgent?: string): number | undefined => {
  const match = /^yarn\/(?<major>\d+)\./u.exec(userAgent ?? "");
  return match?.groups?.major === undefined
    ? undefined
    : Number(match.groups.major);
};

/** Environment `buildPlan` and `workspaceNote` read, injectable for tests. */
export interface PlanEnvironment {
  /** `npm_config_user_agent` of the process that ran `init`. */
  userAgent?: string;
}

/**
 * The package-manager config file a project `init` creates from scratch
 * needs: pnpm's build approvals, or Yarn Berry's `node_modules` linker. An
 * existing package.json, or a workspace the project joins, already owns that
 * decision (see {@link workspaceNote}); Yarn Classic ignores `.yarnrc.yml`, so
 * a user agent naming Yarn 1 skips it.
 */
const packageManagerConfigFor = (
  root: string,
  answers: InitAnswers,
  env: PlanEnvironment
): ScaffoldFile[] => {
  if (existsSync(join(root, "package.json"))) {
    return [];
  }
  if (answers.packageManager === "pnpm" && pnpmWorkspaceRoot(root) === null) {
    return [
      { content: PNPM_WORKSPACE, path: join(root, "pnpm-workspace.yaml") },
    ];
  }
  if (
    answers.packageManager === "yarn" &&
    yarnMajor(env.userAgent) !== 1 &&
    yarnProjectRoot(root) === null
  ) {
    return [{ content: YARNRC, path: join(root, ".yarnrc.yml") }];
  }
  return [];
};

const ESBUILD_APPROVAL = "  allowBuilds:\n    esbuild: true";

/**
 * What the project still needs from a workspace it sits in, when `init` left
 * that workspace's config alone: a place in a pnpm workspace's `packages`
 * (pnpm skips a folder it doesn't list), pnpm's approval for esbuild's build
 * script (pnpm 11 and later fail the install without it), or Yarn Berry's
 * `node_modules` linker. Undefined when the workspace already has it, or the
 * project doesn't sit in one.
 */
export const workspaceNote = (
  root: string,
  answers: InitAnswers,
  env: PlanEnvironment = {}
): string | undefined => {
  if (answers.packageManager === "pnpm") {
    const workspace = pnpmWorkspaceRoot(root);
    if (!workspace) {
      return;
    }
    const file = join(workspace, "pnpm-workspace.yaml");
    const approved = readText(file).includes("esbuild");
    if (!listsPackage(workspace, root)) {
      const entry = `  packages:\n    - ${relative(workspace, root)}`;
      return approved
        ? `This folder sits inside the pnpm workspace at ${file}, which doesn't list it under packages, so pnpm won't install it. Add it there before installing:\n\n${entry}`
        : `This folder sits inside the pnpm workspace at ${file}, which doesn't list it under packages, so pnpm won't install it. Add it there before installing, and approve esbuild's build script, or pnpm 11 and later stop the install:\n\n${entry}\n${ESBUILD_APPROVAL}`;
    }
    if (approved) {
      return;
    }
    return `This project joins the pnpm workspace at ${file}. Approve esbuild's build script there before installing, or pnpm 11 and later stop the install:\n\n${ESBUILD_APPROVAL}`;
  }
  if (answers.packageManager !== "yarn" || yarnMajor(env.userAgent) === 1) {
    return;
  }
  const project = yarnProjectRoot(root);
  const rc = project && join(project, ".yarnrc.yml");
  if (!rc || /^nodeLinker:\s*["']?(?:node-modules|pnpm)/mu.test(readText(rc))) {
    return;
  }
  return `This project joins the Yarn project at ${project}. With Yarn 2 or later, set its linker in ${rc} so installs write the node_modules Blume's generated Astro project resolves packages from:\n\n  nodeLinker: node-modules`;
};

/** Every file `init` should write for the given answers, package.json first. */
export const buildPlan = (
  root: string,
  answers: InitAnswers,
  env: PlanEnvironment = {}
): ScaffoldFile[] => {
  const starter: Starter = STARTERS[answers.template];
  const files: ScaffoldFile[] = [
    {
      content: blumePackageJson(
        toPackageName(basename(root)),
        extraDepsFor(answers.sources)
      ),
      path: join(root, "package.json"),
    },
    ...packageManagerConfigFor(root, answers, env),
    { content: buildConfig(answers), path: join(root, "blume.config.ts") },
    ...(starter.projectFiles ?? []).map((file) => ({
      ...file,
      path: join(root, file.path),
    })),
  ];
  // Seed pages only make sense when a local filesystem source will read them.
  if (answers.sources.length === 0 || answers.sources.includes("filesystem")) {
    files.push(
      ...starter
        .files(answers.contentDir)
        .map((file) => ({ ...file, path: join(root, file.path) }))
    );
  }
  // The obsidian snippet points at `vault/`; seed the directory with a first
  // note so the scaffolded project passes the source's `validate()` and boots
  // before the user has opened Obsidian at all.
  if (answers.sources.includes("obsidian")) {
    files.push({
      content:
        "# Welcome\n\nThis folder is read by Blume's `obsidian` source. Open it as a vault in Obsidian and write notes — `[[Wikilinks]]` become site links.\n",
      path: join(root, "vault", "Welcome.md"),
    });
  }
  return files;
};

const writeFileSafe = async (
  file: ScaffoldFile,
  log: ScaffoldLog
): Promise<boolean> => {
  if (existsSync(file.path)) {
    log.info(`Skipped existing ${file.path}`);
    return false;
  }
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.content, "utf-8");
  log.success(`Created ${file.path}`);
  return true;
};

/**
 * Write the plan's files, skipping any that already exist. Reports whether a
 * `package.json` was newly created (it decides whether `init` installs).
 */
export const applyPlan = async (
  files: ScaffoldFile[],
  log: ScaffoldLog
): Promise<{ createdPackage: boolean }> => {
  const created = await Promise.all(
    files.map((file) => writeFileSafe(file, log))
  );
  const createdPackage = files.some(
    (file, index) => created[index] && basename(file.path) === "package.json"
  );
  return { createdPackage };
};

/** Env vars the selected sources declare, deduplicated in a stable order. */
const envVarsFor = (sources: SourceKind[]): string[] => [
  ...new Set(
    descriptorsFor(sources).flatMap((descriptor) => descriptor.requiredSecrets)
  ),
];

/** What an existing package.json — one `init` left alone — already wires up. */
export interface ExistingPackage {
  /**
   * Whether `blume` is installed where the project resolves it: its own
   * `node_modules`, or an ancestor's in a hoisted workspace. Listing it isn't
   * enough — a rerun of `init --no-install` lists it without installing it.
   */
  blumeInstalled: boolean;
  /** Every package it lists in `dependencies` or `devDependencies`. */
  dependencies: string[];
  /** Whether its `dev` script runs Blume. */
  devRunsBlume: boolean;
}

/** Whether a `node_modules/blume` sits in `root` or any directory above it. */
const blumeResolves = (root: string): boolean => {
  let dir = root;
  while (!existsSync(join(dir, "node_modules", "blume", "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
  return true;
};

/**
 * Read the package.json `init` didn't write. An unreadable or malformed one
 * reads as wiring nothing up, so the next steps list everything to add.
 */
export const readExistingPackage = async (
  root: string
): Promise<ExistingPackage> => {
  try {
    // SAFETY: only the two dependency maps and the `dev` script are read, all
    // optional; `String()` absorbs a script that isn't a string.
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf-8")
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    return {
      blumeInstalled: blumeResolves(root),
      dependencies: Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
      }),
      devRunsBlume: String(pkg.scripts?.dev ?? "").includes("blume"),
    };
  } catch {
    return {
      blumeInstalled: blumeResolves(root),
      dependencies: [],
      devRunsBlume: false,
    };
  }
};

/**
 * The next-steps message: `cd` hint, the install command when `init` did not
 * run it itself, the dev command, and token setup. With an `existing`
 * package.json — which `init` never edits — it first adds whatever of `blume`
 * and the sources' SDKs isn't listed yet (or installs, when everything is
 * listed but `blume` was never installed), then starts the dev server through
 * the package runner unless its `dev` script already runs Blume. A `note` —
 * what a workspace the project joins still needs — closes the message.
 */
export const nextSteps = (
  answers: InitAnswers,
  needsInstall: boolean,
  existing?: ExistingPackage,
  note?: string
): string => {
  const commands = commandsFor(answers.packageManager);
  const lines: string[] = [];
  if (answers.directory !== ".") {
    lines.push(cdCommand(answers.directory));
  }
  if (needsInstall) {
    lines.push(commands.install);
  }
  if (existing) {
    const missing = [
      "blume",
      ...Object.keys(extraDepsFor(answers.sources)),
    ].filter((dep) => !existing.dependencies.includes(dep));
    if (missing.length > 0) {
      lines.push(`${commands.add} ${missing.join(" ")}`);
    } else if (!(needsInstall || existing.blumeInstalled)) {
      lines.push(commands.install);
    }
  }
  lines.push(
    existing && !existing.devRunsBlume
      ? `${commands.exec} blume dev`
      : commands.dev
  );
  const envVars = envVarsFor(answers.sources);
  const auth =
    envVars.length > 0
      ? `\nSet ${envVars.join(" and ")} in .env.local so your sources can authenticate.\n`
      : "";
  const workspace = note ? `\n${note}\n` : "";
  return `Next steps:\n\n  ${lines.join("\n  ")}\n${auth}${workspace}`;
};
