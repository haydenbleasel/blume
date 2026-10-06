import { resolveLocalizable } from "./localizable.ts";
import type { LocalizableLabel } from "./schema.ts";

/**
 * Clients the "Connect to MCP" page action knows how to install the server
 * into, in display order. Shared by the config schema (`agents.mcp.clients`
 * entries validate against this list) and the PageActions menu (which renders
 * the full list when the config is `true`). Lives outside `schema.ts` so the
 * component can import the list without pulling the whole config schema into
 * the layout module graph.
 */
export const mcpClients = ["claude-code", "codex", "cursor", "vscode"] as const;

export type McpClient = (typeof mcpClients)[number];

/**
 * A client Blume doesn't ship: a menu row that copies `command`, with
 * `{name}` (the server name as an id, like `acme-docs`) and `{url}` (the
 * server's absolute URL) filled in.
 */
export interface McpCustomClient {
  /**
   * Command the row copies, with `{name}` (the server name as an id, like
   * `acme-docs`) and `{url}` (the server's absolute URL) filled in.
   */
  command: string;
  /** Icon beside the label: a Lucide name, inline SVG, or image. Defaults to `terminal`. */
  icon?: string;
  /** Row label, optionally per locale (`{ en: "…", de: "…" }`). */
  label: LocalizableLabel;
}

export type McpClientEntry = McpClient | McpCustomClient;

/** A menu entry as a page renders it: a custom label resolved to its locale. */
export type McpMenuEntry =
  | McpClient
  | (Omit<McpCustomClient, "label"> & { label: string });

/** Whether a `clients` entry names a built-in client rather than a custom one. */
export const isBuiltInMcpClient = (
  client: McpClientEntry | McpMenuEntry
): client is McpClient => typeof client === "string";

/** Resolve the custom clients' labels for one page's locale. */
export const mcpMenuEntries = (
  clients: readonly McpClientEntry[],
  locale?: string,
  defaultLocale?: string
): McpMenuEntry[] =>
  clients.map((client) =>
    isBuiltInMcpClient(client)
      ? client
      : {
          ...client,
          label: resolveLocalizable(client.label, locale, defaultLocale),
        }
  );

/** Whether a row opens an install link rather than copying a command. */
const opensLink = (client: McpMenuEntry): boolean =>
  client === "cursor" || client === "vscode";

/**
 * The menu's rows after "Copy server URL", each with whether a rule goes
 * above it: wherever the list switches between commands to copy and install
 * links ("Copy server URL" copies too), so the default menu keeps its one
 * rule before Cursor.
 */
export const mcpMenuRows = (
  entries: readonly McpMenuEntry[]
): { client: McpMenuEntry; rule: boolean }[] =>
  entries.map((client, index) => {
    const previous = entries[index - 1];
    return {
      client,
      rule:
        opensLink(client) !== (previous !== undefined && opensLink(previous)),
    };
  });

/** Fill a custom client's command for the server it installs. */
export const mcpClientCommand = (
  command: string,
  server: { name: string; url: string }
): string =>
  // Replacer functions, not strings: a URL may contain `$`, which a string
  // replacement would interpret as a substitution pattern.
  command
    .replaceAll("{name}", () => server.name)
    .replaceAll("{url}", () => server.url);
