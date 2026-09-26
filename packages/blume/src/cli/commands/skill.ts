import { defineCommand } from "citty";
import { join } from "pathe";

import {
  planSkill,
  WRITE_SKILL_DIR,
  writeSkillPrompt,
} from "../../ai/write-skill.ts";
import { AGENTS, launchInstalledAgent } from "../../audit/agent.ts";
import type { AgentKind } from "../../audit/agent.ts";
import { BlumeError } from "../../core/diagnostics.ts";
import { packageRoot } from "../../core/package-root.ts";
import { scanProject } from "../../core/project-graph.ts";
import { getBlumeVersion } from "../../core/version.ts";
import { commandMeta } from "../command-meta.ts";
import { reportInternalError } from "../internal-error.ts";
import { logger, reportDiagnostics } from "../log.ts";

/**
 * `blume skill` — write the docs site's agent skill with a coding agent. Every
 * build publishes a generated skill at `/skill.md` (a map of the docs); this
 * opens Claude Code or Codex on the `blume-write-skill` skill bundled in this
 * package to write the richer one, grounded in the docs, under the same name
 * so it takes the generated one's place. The judgment stays in the skill; the
 * command is the front door, like `blume migrate`. Status lines go straight to
 * stderr: consola drops info-level lines in test and CI environments.
 */
export const skillCommand = defineCommand({
  args: {
    claude: {
      description: "Write the skill with Claude Code.",
      type: "boolean",
    },
    codex: {
      description: "Write the skill with Codex.",
      type: "boolean",
    },
  },
  meta: commandMeta.skill,
  async run({ args }) {
    const root = process.cwd();
    // SAFETY: AGENTS is a closed record keyed by AgentKind, so its keys are
    // exactly the agent kinds.
    const agents = (Object.keys(AGENTS) as AgentKind[]).filter(
      (kind) => args[kind]
    );
    if (agents.length > 1) {
      logger.error("Pass at most one of --codex or --claude.");
      process.exit(1);
    }
    const [agent] = agents;

    try {
      // A scan, not `prepareProject`: the agent reads the content tree and
      // the runtime isn't touched, so a running dev server is left alone.
      const plan = planSkill(await scanProject(root, { mode: "build" }));
      const skillDir = join(packageRoot(), WRITE_SKILL_DIR);
      process.stderr.write(
        `  ${plan.exists ? "Updating" : "Writing"} the "${plan.name}" skill at ${plan.file}.\n`
      );

      // Without an agent flag the command is the pointer for any other agent:
      // the bundled skill's path, and the install line that puts the skill
      // where agents look for it.
      if (!agent) {
        process.stderr.write(
          `  blume skill writes it with a coding agent: rerun with --codex or --claude.\n  Using another agent? Point it at ${join(skillDir, "SKILL.md")},\n  or install the skill where your agent looks for skills: npx skills add haydenbleasel/blume --skill blume-write-skill\n`
        );
        return;
      }

      const cli = AGENTS[agent];
      process.stderr.write(`  Handing it to ${cli.name}…\n\n`);
      const code = await launchInstalledAgent(
        cli.bin,
        writeSkillPrompt(plan, { skillDir, version: getBlumeVersion() })
      );
      if (code === null) {
        logger.error(
          `${cli.name} (\`${cli.bin}\`) was not found on PATH. Install it with \`${cli.install}\`.`
        );
        process.exit(1);
      }
      if (code !== 0) {
        process.exit(code);
      }
    } catch (error) {
      if (error instanceof BlumeError) {
        reportDiagnostics([error.diagnostic], root);
        process.exit(1);
      }
      reportInternalError(error);
      process.exit(1);
    }
  },
});
