import type { CommandMeta } from "citty";

/**
 * Every command's `meta`, held apart from the command modules themselves.
 *
 * The CLI entry loads each command lazily (see `lazy-command.ts`), but citty
 * still reads every subcommand's `meta` to render `blume --help` and to match
 * an unknown name against aliases. Keeping that table here lets those paths
 * run without importing a single command module — `dev` alone drags in Astro,
 * `mcp-stdio` the MCP SDK. The command modules read their `meta` from this
 * table too, so the entry and the command can't drift.
 */
export const commandMeta = {
  add: {
    description: "Install a source component or template from the registry.",
    name: "add",
  },
  audit: {
    description: "Audit the built site for SEO and site-health issues.",
    name: "audit",
  },
  build: {
    description: "Build the docs site for production.",
    name: "build",
  },
  check: {
    description: "Type-check the docs site with astro check.",
    name: "check",
  },
  dev: {
    description: "Start the Blume development server.",
    name: "dev",
  },
  doctor: {
    description: "Diagnose common configuration and content problems.",
    name: "doctor",
  },
  eject: {
    description: "Promote the generated runtime into an owned Astro project.",
    name: "eject",
  },
  eval: {
    description:
      "Test the docs: an agent answers your questions using only the documentation.",
    name: "eval",
  },
  init: {
    description: "Scaffold a minimal Blume project.",
    name: "init",
  },
  "mcp-stdio": {
    description:
      "Serve an MCP data snapshot over stdio (internal, used by `blume eval`).",
    name: "mcp-stdio",
  },
  migrate: {
    description:
      "Migrate a docs site from Mintlify, Fumadocs, Docusaurus, Starlight, or Nextra with a coding agent.",
    name: "migrate",
  },
  preview: {
    description: "Preview the last production build.",
    name: "preview",
  },
  skill: {
    description:
      "Write the docs site's agent skill with a coding agent, in place of the generated one.",
    name: "skill",
  },
  sync: {
    description: "Re-fetch remote content sources and regenerate the runtime.",
    name: "sync",
  },
  translate: {
    description:
      "Translate docs into the configured locales with a local agent CLI.",
    name: "translate",
  },
  upgrade: {
    description:
      "Upgrade to this version of Blume: bump the dependency and list the config changes left.",
    name: "upgrade",
  },
  validate: {
    description: "Validate internal, anchor, asset, and external links.",
    name: "validate",
  },
  version: {
    description: "Freeze the current docs as an archived version.",
    name: "version",
  },
} satisfies Record<string, CommandMeta>;
