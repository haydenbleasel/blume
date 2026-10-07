import { describe, expect, it } from "bun:test";

import type { McpConfig } from "../src/core/config-input.ts";
import {
  mcpClientCommand,
  mcpClients,
  mcpMenuEntries,
  mcpMenuRows,
} from "../src/core/mcp-clients.ts";
import type { McpClient } from "../src/core/mcp-clients.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

const clients = (value: McpConfig["clients"]) =>
  blumeConfigSchema.parse({ agents: { mcp: { clients: value } } }).agents.mcp
    .clients;

// Invalid input goes through the schema as written, unchecked by the types.
const issues = (value: readonly (number | object | string)[] | string) => {
  const result = blumeConfigSchema.safeParse({
    agents: { mcp: { clients: value } },
  });
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join("."),
      }));
};

const copilot = {
  command: "copilot mcp add --transport http {name} {url}",
  label: "Copy Copilot CLI command",
};

describe("agents.mcp.clients schema", () => {
  it("defaults to every built-in client, in display order", () => {
    const expected: McpClient[] = ["claude-code", "codex", "cursor", "vscode"];
    expect(blumeConfigSchema.parse({}).agents.mcp.clients).toStrictEqual(
      expected
    );
    expect(clients(true)).toStrictEqual(expected);
    expect([...mcpClients]).toStrictEqual(expected);
  });

  it("normalizes false to an empty list", () => {
    expect(clients(false)).toStrictEqual([]);
  });

  it("keeps built-in and custom clients in the configured order", () => {
    expect(
      clients(["vscode", { ...copilot, icon: "github" }, "claude-code"])
    ).toStrictEqual(["vscode", { ...copilot, icon: "github" }, "claude-code"]);
  });

  it("trims a custom command and takes a per-locale label", () => {
    const label = {
      en: "Copy Copilot CLI command",
      sv: "Kopiera Copilot CLI-kommando",
    };
    expect(
      clients([{ command: `  ${copilot.command}\n`, label }])
    ).toStrictEqual([{ command: copilot.command, label }]);
  });

  it("names an unknown built-in client and the entries the list takes", () => {
    expect(issues(["claude-code", "copilot"])).toStrictEqual([
      {
        message:
          'agents.mcp.clients.1 is "copilot", which isn\'t a built-in client. Use "claude-code", "codex", "cursor", "vscode", or a custom client { label, command, icon? }.',
        path: "agents.mcp.clients",
      },
    ]);
    expect(issues("claude-code")[0]?.message).toBe(
      'agents.mcp.clients takes true, false, or a list whose entries are each "claude-code", "codex", "cursor", "vscode", or a custom client { label, command, icon? }.'
    );
    expect(issues([""])[0]?.message).toStartWith(
      'agents.mcp.clients.0 is "", which isn\'t a built-in client.'
    );
  });

  it("rejects a repeated built-in client", () => {
    expect(() => clients(["codex", copilot, "codex"])).toThrow(
      "agents.mcp.clients must not repeat a built-in client."
    );
  });

  it("names the field a custom client gets wrong", () => {
    const [missing] = issues([
      "codex",
      { commmand: copilot.command, label: copilot.label },
    ]);
    expect(missing?.message).toStartWith("agents.mcp.clients.1.command: ");
    expect(missing?.message).toEndWith(
      ". A custom client is { label, command, icon? }."
    );
    expect(issues([{ command: copilot.command }])[0]?.message).toStartWith(
      "agents.mcp.clients.0.label: "
    );
    expect(issues([{ ...copilot, icon: 5 }])[0]?.message).toStartWith(
      "agents.mcp.clients.0.icon: "
    );
    expect(issues([5])[0]?.message).toBe(
      'agents.mcp.clients.0 isn\'t "claude-code", "codex", "cursor", "vscode", or a custom client { label, command, icon? }.'
    );
  });

  it("blames the entry that fails, not a blank field or unknown key on another", () => {
    // Those don't fail the list on their own, so zod carries them along beside
    // the entry that does.
    expect(
      issues([{ ...copilot, icn: "terminal" }, "claude"])[0]?.message
    ).toStartWith('agents.mcp.clients.1 is "claude", which isn\'t');
    expect(
      issues([{ command: "", label: "Copy" }, { label: "Copy" }])[0]?.message
    ).toStartWith("agents.mcp.clients.1.command: ");
  });

  it("says what a label takes when one is missing or malformed", () => {
    for (const entry of [
      { command: copilot.command },
      { command: copilot.command, label: { en: 5 } },
    ]) {
      expect(issues([entry])[0]?.message).toBe(
        "agents.mcp.clients.0.label: Expected a label, or a map of locale code to label. A custom client is { label, command, icon? }."
      );
    }
  });

  it("rejects a blank command or label at its own field, and extra keys", () => {
    // The label is the row button's only accessible name.
    expect(issues([{ command: "  ", label: copilot.label }])).toStrictEqual([
      expect.objectContaining({ path: "agents.mcp.clients.0.command" }),
    ]);
    expect(issues([{ command: copilot.command, label: " " }])).toStrictEqual([
      expect.objectContaining({ path: "agents.mcp.clients.0.label" }),
    ]);
    expect(
      issues([{ command: copilot.command, label: { en: "Copy", sv: "" } }])
    ).toStrictEqual([
      expect.objectContaining({ path: "agents.mcp.clients.0.label.sv" }),
    ]);
    expect(issues([{ command: copilot.command, label: {} }])).toStrictEqual([
      {
        message: "Provide at least one locale's label.",
        path: "agents.mcp.clients.0.label",
      },
    ]);
    expect(issues([{ ...copilot, href: "https://example.com" }])).toStrictEqual(
      [
        {
          message: 'Unrecognized key: "href"',
          path: "agents.mcp.clients.0",
        },
      ]
    );
  });
});

describe("mcpMenuEntries", () => {
  const label = {
    en: "Copy Copilot CLI command",
    sv: "Kopiera Copilot CLI-kommando",
  };

  it("keeps built-in clients and resolves a custom label to the page's locale", () => {
    expect(
      mcpMenuEntries(["claude-code", { ...copilot, label }], "sv", "en")
    ).toStrictEqual([
      "claude-code",
      { ...copilot, label: "Kopiera Copilot CLI-kommando" },
    ]);
  });

  it("falls back to the default locale's label, and passes a plain label through", () => {
    expect(
      mcpMenuEntries([{ ...copilot, label }, copilot], "de", "en")
    ).toStrictEqual([copilot, copilot]);
  });
});

// Whether each row after "Copy server URL" gets a rule above it.
const rules = (entries: Parameters<typeof mcpMenuRows>[0]) =>
  mcpMenuRows(entries).map(({ rule }) => rule);

describe("mcpMenuRows", () => {
  it("keeps the default menu's one rule, before the install links", () => {
    expect(rules(mcpClients)).toStrictEqual([false, false, true, false]);
  });

  it("draws a rule wherever the list switches between commands and links", () => {
    expect(rules(["vscode", copilot, "claude-code"])).toStrictEqual([
      true,
      true,
      false,
    ]);
    expect(
      mcpMenuRows(["vscode", copilot]).map(({ client }) => client)
    ).toStrictEqual(["vscode", copilot]);
  });

  it("draws none for commands only, and one above a lone link", () => {
    expect(rules(["claude-code", copilot])).toStrictEqual([false, false]);
    expect(rules(["cursor"])).toStrictEqual([true]);
    expect(rules([])).toStrictEqual([]);
  });
});

describe("mcpClientCommand", () => {
  it("fills every {name} and {url}", () => {
    expect(
      mcpClientCommand("tool add {name} {url} # {name}", {
        name: "acme-docs",
        url: "https://docs.example.com/mcp",
      })
    ).toBe("tool add acme-docs https://docs.example.com/mcp # acme-docs");
  });

  it("inserts a URL with `$` literally", () => {
    expect(
      mcpClientCommand("add {url}", {
        name: "docs",
        url: "https://example.com/$&/mcp",
      })
    ).toBe("add https://example.com/$&/mcp");
  });
});
