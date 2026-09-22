import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { detect } from "package-manager-detector/detect";
import { basename, dirname, isAbsolute, join, relative } from "pathe";

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
          label: "Petstore",
          spec: "https://petstore3.swagger.io/api/v3/openapi.json",
        },
      ],
    }),
  ],`,
    configImports: ['import { openapi } from "blume/reference";'],
    files: (dir) => [
      {
        content: page(
          "API Reference",
          "Explore the API.",
          "# API Reference\n\nYour OpenAPI spec renders at [`/api`](/api). Point `openapi()` at your own spec in `blume.config.ts`."
        ),
        path: join(dir, "index.mdx"),
      },
    ],
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
          "Welcome to your new Blume docs.",
          "# Introduction\n\nWrite your docs here, and log releases under `changelog/`."
        ),
        path: join(dir, "index.mdx"),
      },
      {
        content: `---\ntitle: v1.0.0\ntype: changelog\ndate: 2026-01-01\n---\n\nThe first release. Edit \`${dir}/changelog/v1-0-0.mdx\` or add new entries beside it.\n`,
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
          "Welcome to your new Blume docs.",
          `# Introduction\n\nWelcome to **Blume** — markdown-first docs powered by Astro and Vite.\n\nEdit \`${dir}/index.mdx\` to get started, then run \`blume dev\`.`
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
          "Get started with the SDK.",
          "# Introduction\n\nInstall the SDK and make your first call. See [Installation](/installation)."
        ),
        path: join(dir, "index.mdx"),
      },
      {
        content: page(
          "Installation",
          "Install the SDK.",
          "# Installation\n\n```package-install\nyour-sdk\n```"
        ),
        path: join(dir, "installation.mdx"),
      },
    ],
  },
} satisfies Record<Template, Starter>;

/**
 * Install + dev commands to print for the chosen package manager, plus the
 * prefix that runs a locally installed bin (`exec`, e.g. `npx blume eject`) —
 * dependency bins aren't on PATH, so a bare `blume …` hint would not run.
 */
export const commandsFor = (pm: PackageManager) => ({
  // `bun build` invokes Bun's bundler, not the package.json `build` script —
  // unlike `bun dev`, the script name is shadowed by a builtin subcommand.
  build: pm === "npm" || pm === "bun" ? `${pm} run build` : `${pm} build`,
  dev: pm === "npm" ? "npm run dev" : `${pm} dev`,
  exec: { bun: "bunx", npm: "npx", pnpm: "pnpm exec", yarn: "yarn" }[pm],
  install: `${pm} install`,
});

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
  ["@sanity/client", "^7.25.0"],
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

/** Every file `init` should write for the given answers, package.json first. */
export const buildPlan = (
  root: string,
  answers: InitAnswers
): ScaffoldFile[] => {
  const files: ScaffoldFile[] = [
    {
      content: blumePackageJson(
        toPackageName(basename(root)),
        extraDepsFor(answers.sources)
      ),
      path: join(root, "package.json"),
    },
    { content: buildConfig(answers), path: join(root, "blume.config.ts") },
  ];
  // Seed pages only make sense when a local filesystem source will read them.
  if (answers.sources.length === 0 || answers.sources.includes("filesystem")) {
    files.push(
      ...STARTERS[answers.template]
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

/**
 * The next-steps message: `cd` hint, the install command when `init` did not
 * run it itself, the dev command, and token setup.
 */
export const nextSteps = (
  answers: InitAnswers,
  needsInstall: boolean
): string => {
  const commands = commandsFor(answers.packageManager);
  const lines: string[] = [];
  if (answers.directory !== ".") {
    lines.push(`cd ${answers.directory}`);
  }
  if (needsInstall) {
    lines.push(commands.install);
  }
  lines.push(commands.dev);
  const envVars = envVarsFor(answers.sources);
  const auth =
    envVars.length > 0
      ? `\nSet ${envVars.join(" and ")} in .env.local so your sources can authenticate.\n`
      : "";
  return `Next steps:\n\n  ${lines.join("\n  ")}\n${auth}`;
};
