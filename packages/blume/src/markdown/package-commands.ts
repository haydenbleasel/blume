import type { Agent, Command } from "package-manager-detector";
import { resolveCommand } from "package-manager-detector/commands";

/** Supported package managers, in the order tabs are displayed. */
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * The agent each tab renders. The yarn tab is pinned to Berry (yarn 2+ — the
 * only supported line): the pre-existing mix emitted Berry-only `yarn dlx` and
 * `--immutable` next to Classic-only `yarn global add`, so no single yarn
 * version could run every rendered command. Berry removed `global`
 * (yarnpkg/berry#821), so global installs on the yarn tab honestly render
 * npm's form, matching `ni`'s table.
 */
const AGENT_FOR = {
  bun: "bun",
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn@berry",
} satisfies Record<PackageManager, Agent>;

/** Words that mark the input as an explicit command rather than a bare list. */
const MANAGER_PREFIXES = new Set(["bun", "bunx", "npm", "npx", "pnpm", "yarn"]);

const WHITESPACE = /\s+/u;
const WHITESPACE_RUN = /\s+/gu;
const GLOBAL_FLAGS = new Set(["-g", "--global"]);

type Operation =
  | "add"
  | "ci"
  | "create"
  | "exec"
  | "install"
  | "remove"
  | "run";

interface Intent {
  args: string[];
  operation: Operation;
}

/** Map a package-manager subcommand to a normalized operation. */
const normalizeVerb = (verb: string): Operation | null => {
  switch (verb) {
    case "add":
    case "i":
    case "in":
    case "install": {
      return "add";
    }
    case "ci": {
      return "ci";
    }
    case "create":
    case "init": {
      return "create";
    }
    case "dlx":
    case "exec":
    case "x": {
      return "exec";
    }
    case "remove":
    case "rm":
    case "un":
    case "uninstall": {
      return "remove";
    }
    case "run": {
      return "run";
    }
    default: {
      return null;
    }
  }
};

/** Normalize npm-style flags to forms every manager understands. */
const normalizeFlags = (args: string[]): string[] =>
  args.flatMap((arg) => {
    if (arg === "--save-dev") {
      return ["-D"];
    }
    if (arg === "--save" || arg === "-S") {
      return [];
    }
    return [arg];
  });

/**
 * Parse an input command (a bare package list like `react react-dom` or an
 * explicit command like `npm i -D typescript` / `npx astro add`) into a
 * manager-agnostic intent.
 */
const parseIntent = (input: string): Intent => {
  const tokens = input.trim().split(WHITESPACE).filter(Boolean);
  const [first, ...rest] = tokens;
  if (first === undefined) {
    return { args: [], operation: "install" };
  }
  if (!MANAGER_PREFIXES.has(first)) {
    return { args: normalizeFlags(tokens), operation: "add" };
  }
  if (first === "npx" || first === "bunx") {
    return { args: rest, operation: "exec" };
  }

  const [verb, ...verbArgs] = rest;
  if (!verb) {
    return { args: [], operation: "install" };
  }
  // Yarn Classic spells global installs `yarn global <add|remove> …`; map it
  // onto the flag-style intent so every manager renders its own global form
  // instead of falling into the run-as-script branch.
  if (first === "yarn" && verb === "global") {
    const [globalVerb, ...globalArgs] = verbArgs;
    const globalOp = globalVerb ? normalizeVerb(globalVerb) : null;
    if (globalOp === "add" || globalOp === "remove") {
      return {
        args: [...normalizeFlags(globalArgs), "-g"],
        operation: globalOp,
      };
    }
  }
  const operation = normalizeVerb(verb);
  if (operation === null) {
    // Unknown subcommand (e.g. `npm test`); run it as a script.
    return { args: rest, operation: "run" };
  }
  if (operation === "add" && verbArgs.length === 0) {
    return { args: [], operation: "install" };
  }
  return { args: normalizeFlags(verbArgs), operation };
};

/** The package-manager-detector command for each non-global operation. */
const COMMAND_FOR = {
  add: "add",
  ci: "frozen",
  exec: "execute",
  install: "install",
  remove: "uninstall",
  run: "run",
} satisfies Record<Exclude<Operation, "create">, Command>;

/**
 * Render one manager's command for the given intent, via
 * package-manager-detector's maintained agent tables (the engine behind `ni`).
 */
const buildCommand = (manager: PackageManager, intent: Intent): string => {
  // The tables carry no `create`; every manager spells it the same way.
  if (intent.operation === "create") {
    return `${manager} create ${intent.args.join(" ")}`;
  }
  // A `-g`/`--global` flag selects the dedicated global command (the tables
  // place the flag themselves, per manager).
  const global =
    (intent.operation === "add" || intent.operation === "remove") &&
    intent.args.some((arg) => GLOBAL_FLAGS.has(arg));
  const args = global
    ? intent.args.filter((arg) => !GLOBAL_FLAGS.has(arg))
    : intent.args;
  const command: Command = global
    ? (intent.operation === "add" && "global") || "global_uninstall"
    : COMMAND_FOR[intent.operation];
  // Non-null: every operation above maps to a command each supported agent's
  // table defines (null is only possible for gaps like npm's
  // upgrade-interactive, which no Operation reaches).
  const resolved = resolveCommand(AGENT_FOR[manager], command, args);
  const words = resolved
    ? [resolved.command, ...resolved.args]
    : [manager, ...args];
  // Docs favor the explicit spellings over the tables' terse aliases.
  if (words[1] === "i") {
    words[1] = "install";
  }
  if (words[0] === "bun" && words[1] === "x") {
    words.splice(0, 2, "bunx");
  }
  return words.join(" ");
};

/**
 * Convert an install command into the equivalent for every supported package
 * manager. Accepts a bare package list (`react`) or a full command
 * (`npm i -D typescript`, `npx astro add react`).
 */
export const toPackageCommands = (input: string) => {
  const intent = parseIntent(input);
  const normalize = (command: string): string =>
    command.replaceAll(WHITESPACE_RUN, " ").trim();
  return {
    bun: normalize(buildCommand("bun", intent)),
    npm: normalize(buildCommand("npm", intent)),
    pnpm: normalize(buildCommand("pnpm", intent)),
    yarn: normalize(buildCommand("yarn", intent)),
  } satisfies Record<PackageManager, string>;
};
