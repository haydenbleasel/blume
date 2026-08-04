import type { AgentKind } from "../audit/agent.ts";
import { DISALLOWED_TOOLS } from "../eval/agents.ts";

/**
 * argv builders for the translator role. The subprocess machinery
 * (`runAgentHeadless`, `readAgentOutput`, the `HeadlessRunner` test seam) is
 * shared with `blume eval` — only the argument surface differs: a translator
 * is a pure text→text call with no MCP servers and no tools at all, so the
 * agent can neither read the repo nor write files (Blume owns every write).
 */

/** Wall-clock ceiling per file — the eval reader's precedent. */
export const DEFAULT_TRANSLATE_TIMEOUT_MS = 180_000;

const claudeArgs = (): string[] => [
  "-p",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--disallowedTools",
  DISALLOWED_TOOLS.join(","),
  "--max-turns",
  "1",
];

const codexArgs = (lastMessagePath: string): string[] => [
  "exec",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ephemeral",
  "--sandbox",
  "read-only",
  "--output-last-message",
  lastMessagePath,
  "-",
];

/**
 * Build the argv for one headless translation call. `lastMessagePath` is where
 * codex writes its final message (its stdout interleaves progress); claude
 * ignores it and answers as JSON on stdout.
 */
export const translateAgentArgs = (
  kind: AgentKind,
  lastMessagePath: string
): string[] => (kind === "claude" ? claudeArgs() : codexArgs(lastMessagePath));
