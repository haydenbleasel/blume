import { describe, expect, it } from "bun:test";

import matter from "../src/core/frontmatter.ts";
import { metaPrompt, pagePrompt } from "../src/translate/prompts.ts";
import {
  parseMetaTitles,
  stripOuterFence,
  validateTranslation,
} from "../src/translate/validate.ts";

const EN = { code: "en", dir: "ltr" as const, label: "English" };
const FR = { code: "fr", dir: "ltr" as const, label: "French" };

const SOURCE = `---
title: Install
description: How to install.
sidebar:
  label: Install
  order: 2
slug: install
---
# Install

Run the installer.

\`\`\`sh
npm install blume
\`\`\`
`;

const okText = (source: string, agent: string): string => {
  const result = validateTranslation(source, agent);
  if (!result.ok) {
    throw new Error(`expected ok, got: ${result.reason}`);
  }
  return result.text;
};

const failReason = (source: string, agent: string): string => {
  const result = validateTranslation(source, agent);
  if (result.ok) {
    throw new Error("expected failure");
  }
  return result.reason;
};

describe("stripOuterFence", () => {
  it("strips exactly one symmetric outer fence, any info string", () => {
    expect(stripOuterFence("```md\n# Hi\n```")).toBe("# Hi");
    expect(stripOuterFence("```\n# Hi\n```")).toBe("# Hi");
    expect(stripOuterFence("~~~markdown\n# Hi\n~~~")).toBe("# Hi");
    expect(stripOuterFence("````\ntext with ``` inside\n````")).toBe(
      "text with ``` inside"
    );
  });

  it("leaves unfenced and partially fenced output untouched (trimmed)", () => {
    expect(stripOuterFence("  # Hi\n")).toBe("# Hi");
    expect(stripOuterFence("# Hi\n\n```sh\nnpm i\n```")).toBe(
      "# Hi\n\n```sh\nnpm i\n```"
    );
    expect(stripOuterFence("Here you go:\n```\n# Hi\n```")).toBe(
      "Here you go:\n```\n# Hi\n```"
    );
  });
});

describe("validateTranslation", () => {
  it("accepts a faithful translation and reassembles from the source data", () => {
    const agent = `---
title: Installation
description: Comment installer.
sidebar:
  label: Installation
  order: 2
slug: install
---
# Installation

Lancez l'installateur.

\`\`\`sh
npm install blume
\`\`\`
`;
    const text = okText(SOURCE, agent);
    const parsed = matter(text);
    expect(parsed.data).toStrictEqual({
      description: "Comment installer.",
      sidebar: { label: "Installation", order: 2 },
      slug: "install",
      title: "Installation",
    });
    expect(parsed.content).toContain("# Installation");
    expect(parsed.content).toContain("npm install blume");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("restores keys the agent deleted and drops keys it invented", () => {
    const agent = `---
title: Installation
invented: should not survive
seo:
  title: also invented
---
# Installation

Lancez l'installateur.

\`\`\`sh
npm install blume
\`\`\`
`;
    const parsed = matter(okText(SOURCE, agent));
    // Deleted keys restored from the source…
    expect(parsed.data.description).toBe("How to install.");
    expect(parsed.data.sidebar).toStrictEqual({ label: "Install", order: 2 });
    expect(parsed.data.slug).toBe("install");
    // …invented keys gone (seo.title is translatable, but the source has no
    // seo block to overlay onto).
    expect(parsed.data.invented).toBeUndefined();
    expect(parsed.data.seo).toBeUndefined();
    // The translated value that maps onto a source string survives.
    expect(parsed.data.title).toBe("Installation");
  });

  it("keeps the source value when the agent blanks a translatable field", () => {
    const agent = `---
title: ""
---
# Installation

Lancez l'installateur.

\`\`\`sh
npm install blume
\`\`\`
`;
    const parsed = matter(okText(SOURCE, agent));
    expect(parsed.data.title).toBe("Install");
  });

  it("accepts a translation wrapped in a single outer fence", () => {
    const agent = `\`\`\`mdx
---
title: Installation
---
# Installation

Lancez l'installateur.

\`\`\`\`sh
npm install blume
\`\`\`\`
\`\`\``;
    // The outer ``` fence is stripped; the inner ```` fence pair remains and
    // matches the source's fence-line count.
    const text = okText(SOURCE, agent);
    expect(text).toContain("# Installation");
  });

  it("fails on empty output", () => {
    expect(failReason(SOURCE, "")).toContain("empty output");
    expect(failReason(SOURCE, "```\n\n```")).toContain("empty output");
  });

  it("fails when the frontmatter is dropped or unparseable", () => {
    expect(failReason(SOURCE, "# Installation\n\nBonjour.\n")).toContain(
      "dropped the frontmatter"
    );
    expect(
      failReason(SOURCE, '---\ntitle: "unclosed\n---\n# Installation\n')
    ).toContain("does not parse");
  });

  it("fails on an empty body", () => {
    expect(failReason(SOURCE, "---\ntitle: Installation\n---\n")).toContain(
      "empty body"
    );
  });

  it("fails when the code-fence count changes, naming both counts", () => {
    const agent = `---
title: Installation
---
# Installation

Lancez npm install blume.
`;
    const reason = failReason(SOURCE, agent);
    expect(reason).toContain("code fence count changed");
    expect(reason).toContain("2");
    expect(reason).toContain("0");
  });

  it("round-trips a frontmatter-less source as a bare body", () => {
    const source = "# Install\n\nRun the installer.\n";
    const text = okText(source, "# Installation\n\nLancez l'installateur.");
    expect(text).toBe("# Installation\n\nLancez l'installateur.\n");
    // Frontmatter the agent invents on a frontmatter-less source is dropped.
    const stripped = okText(
      source,
      "---\ntitle: Installation\n---\n# Installation\n\nLancez l'installateur.\n"
    );
    expect(stripped.startsWith("# Installation")).toBe(true);
  });
});

describe("parseMetaTitles", () => {
  it("extracts titles from a fenced or prose-wrapped JSON reply", () => {
    const reply =
      'Voilà :\n```json\n{"guides": "Guides FR", "reference": "Référence"}\n```';
    expect(parseMetaTitles(reply, ["guides", "reference"])).toStrictEqual({
      missing: [],
      titles: { guides: "Guides FR", reference: "Référence" },
    });
  });

  it("reports missing, empty, and non-string keys individually", () => {
    const reply = '{"guides": "Guides FR", "reference": 3, "extra": "x"}';
    expect(
      parseMetaTitles(reply, ["guides", "reference", "concepts"])
    ).toStrictEqual({
      missing: ["reference", "concepts"],
      titles: { guides: "Guides FR" },
    });
    expect(parseMetaTitles('{"guides": "  "}', ["guides"]).missing).toEqual([
      "guides",
    ]);
  });

  it("treats garbage and missing JSON as all-missing", () => {
    expect(parseMetaTitles("no json here", ["guides"]).missing).toEqual([
      "guides",
    ]);
    expect(parseMetaTitles("{not json}", ["guides"]).missing).toEqual([
      "guides",
    ]);
    expect(parseMetaTitles('["array"]', ["guides"]).missing).toEqual([
      "guides",
    ]);
  });
});

describe("prompts", () => {
  it("pagePrompt names both locales, the translatable keys, and the rules", () => {
    const prompt = pagePrompt(SOURCE, FR, EN);
    expect(prompt).toContain("English (en)");
    expect(prompt).toContain("French (fr)");
    expect(prompt).toContain("sidebar.label");
    expect(prompt).toContain("seo.description");
    expect(prompt).toContain("Do not wrap it in a code fence");
    expect(prompt).not.toContain("previous translation");
    expect(prompt.endsWith(SOURCE)).toBe(true);
  });

  it("pagePrompt carries a previous translation and the style-match rule", () => {
    const previous = "---\ntitle: Accueil\n---\n# Accueil\n\nBienvenue.\n";
    const prompt = pagePrompt(SOURCE, FR, EN, previous);
    expect(prompt).toContain("The previous translation begins after this line");
    expect(prompt).toContain("Bienvenue.");
    expect(prompt).toContain("register, formality, dialect, and terminology");
    expect(prompt).toContain("word-for-word identical");
    // The source stays last so the "begins after this line" markers hold.
    expect(prompt.endsWith(SOURCE)).toBe(true);
  });

  it("metaPrompt carries the titles JSON and demands same-keys JSON back", () => {
    const prompt = metaPrompt({ guides: "Guides" }, FR, EN);
    expect(prompt).toContain('"guides": "Guides"');
    expect(prompt).toContain("exactly the same keys");
    expect(prompt).toContain("French (fr)");
  });
});
