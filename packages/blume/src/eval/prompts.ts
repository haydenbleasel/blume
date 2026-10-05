import type { EvalQuestion } from "./schema.ts";

/**
 * The reader's instructions. The agent is spawned in an empty directory with
 * its file/shell/web tools disabled, so the prompt's job is to direct it at
 * the MCP docs tools and forbid the one escape hatch that remains: answering
 * from prior knowledge of the product.
 */
export const readerPrompt = (question: EvalQuestion): string =>
  `You are evaluating whether a product's documentation can answer a user's question.

Answer the question below using ONLY the connected documentation tools (search_docs, get_page, list_pages, get_navigation). Rules:
- Do not use prior knowledge about the product. Do not guess.
- Do not read files, run commands, or access the network.
- Search first, then read the most relevant pages with get_page.
- If the documentation does not contain the answer, say exactly what information is missing instead of inventing one.

Question: ${question.question}

Reply with a concise answer containing the specific facts the documentation provides. Plain text only.`;

/** The judge's instructions: grade the answer against the expected facts. */
export const judgePrompt = (question: EvalQuestion, answer: string): string => {
  const facts = question.expected.map((fact) => `- ${fact}`).join("\n");
  return `You are grading an answer against expected facts. Do not use any tools.

Question: ${question.question}

Expected facts — each must be present in substance (paraphrase is fine, contradiction is not):
${facts}

Answer to grade:
"""
${answer}
"""

An answer that states the documentation lacks the information FAILS.

Reply with ONLY this JSON object on a single line, no markdown fences:
{"pass": true|false, "score": 0.0-1.0, "missing": ["expected facts absent or contradicted"], "notes": "one sentence"}`;
};

/**
 * The `--fix` handoff prompt: where the report is, the ground rules, and the
 * `blume eval` command that verifies the fixes (the run's own flags).
 */
export const evalFixPrompt = (reportPath: string, command: string): string =>
  `Fix the documentation gaps found by \`blume eval\` in this project.

The full report is at ${reportPath}. It is JSON: each entry in \`eval.results\` with status "fail" is one question the documentation could not answer. Each carries the \`question\`, the \`expected\` facts, the judge's \`missing\` facts, and the reader agent's \`answer\` (what the docs currently convey). The matching \`diagnostics\` entry names the source \`file\` of the page that should answer it.

Work through every failed question:
1. Read the page named in the finding (or choose the best page when none is named).
2. Edit the documentation so it states the missing facts explicitly. Add prose, not filler; keep the page's voice.
3. Never delete questions from the evals file or weaken expected facts.

When you are done, run \`${command}\` to verify, and repeat until every question passes.`;

/** The `eval init` prompt: draft a starter evals file from the docs. */
export const initPrompt = (evalsPath: string): string =>
  `Draft a starter evals file for \`blume eval\` in this documentation project.

Read the documentation source pages in this project and write ${evalsPath} with about 10 high-value questions a real user would ask — installation, configuration, deployment, and the project's headline features. For each question, list the expected facts a correct answer must state, grounded in what the documentation actually promises (never invent facts the docs don't state).

The file format is YAML:

questions:
  - id: kebab-case-slug
    question: One user question?
    expected:
      - a fact the answer must contain
      - another required fact
    routes:
      - /route/of/the/page/that/answers/it

Rules:
- Every \`expected\` fact must be verifiable in the docs today.
- Prefer questions whose answers live on one page; set \`routes\` to that page.
- Keep ids unique and questions short.

When you are done, print the file and suggest running \`blume eval\` to try it.`;
