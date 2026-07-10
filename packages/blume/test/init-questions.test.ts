import { describe, expect, it } from "bun:test";

import { collectAnswers } from "../src/cli/init/questions.ts";
import type { InitFlags, Prompter } from "../src/cli/init/questions.ts";
import type { SourceKind, Template } from "../src/cli/init/scaffold.ts";

interface FakeAnswers {
  multiselect?: (SourceKind[] | symbol)[];
  select?: (Template | symbol)[];
  text?: (string | symbol)[];
}

interface Fake {
  asked: string[];
  prompter: Prompter;
  textOpts: Parameters<Prompter["text"]>[0][];
}

/** A queue-backed Prompter that records every question it was asked. */
const fakePrompter = (answers: FakeAnswers): Fake => {
  const asked: string[] = [];
  const textOpts: Parameters<Prompter["text"]>[0][] = [];
  const dequeue = <T>(
    queue: (T | symbol)[] | undefined,
    message: string
  ): T | symbol => {
    asked.push(message);
    const value = queue?.shift();
    if (value === undefined) {
      throw new Error(`No scripted answer for: ${message}`);
    }
    return value;
  };
  return {
    asked,
    prompter: {
      multiselect: (opts) =>
        Promise.resolve(
          dequeue(answers.multiselect, opts.message) as SourceKind[] | symbol
        ),
      select: (opts) =>
        Promise.resolve(
          dequeue(answers.select, opts.message) as Template | symbol
        ),
      text: (opts) => {
        textOpts.push(opts);
        return Promise.resolve(dequeue(answers.text, opts.message));
      },
    },
    textOpts,
  };
};

const DEFAULTS: { cwd: string; userAgent?: string } = { cwd: "/work/site" };

const collect = (
  answers: FakeAnswers,
  flags: InitFlags = {},
  defaults = DEFAULTS
) => {
  const fake = fakePrompter(answers);
  return {
    ...fake,
    result: collectAnswers(fake.prompter, flags, defaults),
  };
};

describe("collectAnswers", () => {
  it("runs the full flow and assembles the answers", async () => {
    const { result, asked } = collect(
      {
        multiselect: [["filesystem", "notion"]],
        select: ["api"],
        text: ["./my-docs", "Acme Docs", "content"],
      },
      {},
      { cwd: "/work/site", userAgent: "pnpm/9.1.0 npm/? node/v20.0.0" }
    );
    expect(await result).toEqual({
      contentDir: "content",
      directory: "./my-docs",
      packageManager: "pnpm",
      sources: ["filesystem", "notion"],
      template: "api",
      title: "Acme Docs",
    });
    expect(asked).toEqual([
      "Where should we create your project?",
      "What's your docs site called?",
      "Which template?",
      "Where does your content live?",
      "Content directory?",
    ]);
  });

  it("desugars an empty source selection to filesystem", async () => {
    const { result } = collect({
      multiselect: [[]],
      select: ["docs"],
      text: [".", "Docs", "docs"],
    });
    const answers = await result;
    expect(answers?.sources).toEqual(["filesystem"]);
  });

  it("skips the content dir question without a filesystem source", async () => {
    const { result, asked } = collect({
      multiselect: [["notion"]],
      select: ["docs"],
      text: [".", "Docs"],
    });
    const answers = await result;
    expect(answers?.contentDir).toBe("docs");
    expect(answers?.sources).toEqual(["notion"]);
    expect(asked).not.toContain("Content directory?");
  });

  it("lets explicit flags pre-answer their questions", async () => {
    const { result, asked } = collect(
      {
        multiselect: [["filesystem"]],
        text: ["My Site"],
      },
      {
        contentDir: "content",
        directory: "site",
        packageManager: "yarn",
        template: "sdk",
      }
    );
    expect(await result).toEqual({
      contentDir: "content",
      directory: "site",
      packageManager: "yarn",
      sources: ["filesystem"],
      template: "sdk",
      title: "My Site",
    });
    expect(asked).toEqual([
      "What's your docs site called?",
      "Where does your content live?",
    ]);
  });

  it("derives the title default from the resolved directory", async () => {
    const { result, textOpts } = collect({
      multiselect: [["filesystem"]],
      select: ["docs"],
      text: ["./acme-api", "Acme Api", "docs"],
    });
    await result;
    expect(textOpts[1]?.initialValue).toBe("Acme Api");
  });

  it("validates the title and content dir inline", async () => {
    const { result, textOpts } = collect({
      multiselect: [["filesystem"]],
      select: ["docs"],
      text: [".", "Docs", "docs"],
    });
    await result;
    const [, title, contentDir] = textOpts;
    expect(title?.validate?.("  ")).toBeDefined();
    expect(title?.validate?.("Docs")).toBeUndefined();
    expect(contentDir?.validate?.("../evil")).toBeDefined();
    expect(contentDir?.validate?.("")).toBeUndefined();
    expect(contentDir?.validate?.("docs")).toBeUndefined();
  });

  it("returns null when any prompt is cancelled", async () => {
    const cancel = Symbol("cancel");
    const flows: FakeAnswers[] = [
      { text: [cancel] },
      { text: [".", cancel] },
      { select: [cancel], text: [".", "Docs"] },
      { multiselect: [cancel], select: ["docs"], text: [".", "Docs"] },
      {
        multiselect: [["filesystem"]],
        select: ["docs"],
        text: [".", "Docs", cancel],
      },
    ];
    const results = await Promise.all(
      flows.map((flow) => collect(flow).result)
    );
    for (const result of results) {
      expect(result).toBeNull();
    }
  });

  it("falls back to npm when no user agent is present", async () => {
    const { result } = collect({
      multiselect: [["filesystem"]],
      select: ["docs"],
      text: [".", "Docs", "docs"],
    });
    const answers = await result;
    expect(answers?.packageManager).toBe("npm");
  });
});
