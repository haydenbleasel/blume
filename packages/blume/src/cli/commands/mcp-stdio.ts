import { readFile } from "node:fs/promises";

import { defineCommand } from "citty";

import type { McpData } from "../../ai/mcp/data.ts";
import { serveMcpStdio } from "../../ai/mcp/stdio.ts";

export const mcpStdioCommand = defineCommand({
  args: {
    data: {
      description: "Path to a serialized MCP data snapshot (JSON).",
      required: true,
      type: "string",
    },
  },
  meta: {
    description:
      "Serve an MCP data snapshot over stdio (internal, used by `blume eval`).",
    name: "mcp-stdio",
  },
  async run({ args }) {
    // stdout belongs to the JSON-RPC transport from here on; every diagnostic
    // must go to stderr or the MCP client chokes on the stray line.
    let data: McpData;
    try {
      // SAFETY: the snapshot is written by `blume eval` itself as
      // JSON.stringify of an McpData; a hand-mangled file fails the parse and
      // lands in the catch below.
      data = JSON.parse(await readFile(args.data, "utf-8")) as McpData;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `blume mcp-stdio: cannot load the snapshot at ${args.data}: ${detail}\n`
      );
      process.exit(1);
    }
    await serveMcpStdio(data);
  },
});
