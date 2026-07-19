import { describe, expect, it } from "bun:test";

import { downlevelComponents } from "../src/ai/component-markdown.ts";

describe("downlevelComponents engine", () => {
  it("returns component-free markdown byte-identical", () => {
    const source = "# Plain\n\nJust *prose* with a [link](/a).\n";
    expect(downlevelComponents(source)).toBe(source);
  });

  it("leaves plain markdown with literal `<`/`{` untouched", () => {
    // These would be MDX syntax errors; the hint check skips the parse, and
    // even a hint match must survive the parse failure.
    const source = "Compare a < b and {not jsx}.\n";
    expect(downlevelComponents(source)).toBe(source);
    const withHint = "A <Callout is mentioned, and a < b breaks MDX {here.\n";
    expect(downlevelComponents(withHint)).toBe(withHint);
  });

  it("leaves unknown components verbatim", () => {
    const source = '# T\n\n<Unknown foo="bar" />\n';
    expect(downlevelComponents(source)).toBe(source);
  });

  it("keeps fenced code that shows component markup verbatim", () => {
    const source = [
      "```mdx",
      '<Callout type="info">shown as code</Callout>',
      "```",
      "",
      '<Callout type="info">real</Callout>',
      "",
    ].join("\n");
    const out = downlevelComponents(source);
    expect(out).toContain('<Callout type="info">shown as code</Callout>');
    expect(out).toContain("> **Info**\n>\n> real");
  });

  it("leaves inline (text-level) component usage verbatim", () => {
    const source = 'Before <Callout type="tip">inline</Callout> after.\n';
    expect(downlevelComponents(source)).toBe(source);
  });

  it("preserves surrounding markdown byte-for-byte when splicing", () => {
    const source = [
      "# Title",
      "",
      "Some   *weirdly  spaced*   prose.",
      "",
      '<YouTube id="dQw4w9WgXcQ" />',
      "",
      "- a list",
      "  - nested",
      "",
    ].join("\n");
    const out = downlevelComponents(source);
    expect(out).toBe(
      source.replace(
        '<YouTube id="dQw4w9WgXcQ" />',
        "[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)"
      )
    );
  });

  it("splices multiple components in one document in order", () => {
    const out = downlevelComponents(
      [
        '<Callout type="note">First.</Callout>',
        "",
        "Between.",
        "",
        '<Callout type="danger">Second.</Callout>',
        "",
      ].join("\n")
    );
    expect(out).toBe(
      [
        "> **Note**",
        ">",
        "> First.",
        "",
        "Between.",
        "",
        "> **Danger**",
        ">",
        "> Second.",
        "",
      ].join("\n")
    );
  });

  it("downlevels a component nested inside plain markdown structure", () => {
    const source = [
      "> quoted intro",
      "",
      "- item",
      "",
      '  <YouTube id="dQw4w9WgXcQ" />',
      "",
    ].join("\n");
    const out = downlevelComponents(source);
    expect(out).toContain(
      "[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)"
    );
    expect(out).not.toContain("<YouTube");
  });
});

/** Downlevel a `<TypeTable>` whose `type={{...}}` body is `body`. */
const table = (body: string): string =>
  downlevelComponents(`<TypeTable\n  type={{\n${body}\n  }}\n/>\n`);

describe("TypeTable", () => {
  it("renders a GFM table with optional markers and defaults", () => {
    const out = table(
      [
        '    name: { type: "string", description: "The name.", required: true },',
        '    size: { type: "number", default: "4" },',
      ].join("\n")
    );
    expect(out).toContain("| Prop | Type | Default | Description |");
    expect(out).toContain("| --- | --- | --- | --- |");
    expect(out).toContain("| `name` | `string` | - | The name. |");
    expect(out).toContain("| `size?` | `number` | `4` |  |");
  });

  it("links the type when typeDescriptionLink is set and joins descriptions", () => {
    const out = table(
      '    mode: { type: "Mode", typeDescriptionLink: "/docs/mode", description: "Pick one.", typeDescription: "A union." },'
    );
    expect(out).toContain(
      "| `mode?` | [`Mode`](/docs/mode) | - | Pick one. A union. |"
    );
  });

  it("escapes pipes and flattens newlines in cells", () => {
    const out = table(
      '    kind: { type: "a | b", description: "Line one.\\nLine two." },'
    );
    expect(out).toContain("`a \\| b`");
    expect(out).toContain("Line one. Line two.");
  });

  it("skips the inline-code wrap when a value contains backticks", () => {
    const out = table('    raw: { type: "`a`" },');
    expect(out).toContain("| `raw?` | `a` | - |  |");
    expect(out).not.toContain("``a``");
  });

  it("renders slot children after the table", () => {
    const source = [
      '<TypeTable type={{ a: { type: "string" } }}>',
      "  Extra notes.",
      "</TypeTable>",
      "",
    ].join("\n");
    const out = downlevelComponents(source);
    expect(out).toMatch(/\| `a\?` \| `string` \| - \| {2}\|\n\nExtra notes\./u);
  });

  it("renders only the children when the type map is empty", () => {
    const out = downlevelComponents(
      "<TypeTable type={{}}>\n  Only notes.\n</TypeTable>\n"
    );
    expect(out.trim()).toBe("Only notes.");
  });

  it("stays verbatim when the type prop is missing or not static", () => {
    const missing = "<TypeTable />\n";
    expect(downlevelComponents(missing)).toBe(missing);
    const dynamic = "<TypeTable type={imported.props} />\n";
    expect(downlevelComponents(dynamic)).toBe(dynamic);
    const spread = "<TypeTable {...props} />\n";
    expect(downlevelComponents(spread)).toBe(spread);
  });
});

describe("Callout", () => {
  it("renders a labeled blockquote from the type", () => {
    const out = downlevelComponents(
      '<Callout type="warning">\n  Careful with **this**.\n\n  Second paragraph.\n</Callout>\n'
    );
    expect(out).toBe(
      "> **Warning**\n>\n> Careful with **this**.\n>\n> Second paragraph.\n"
    );
  });

  it("prefers an explicit title and defaults the type to info", () => {
    expect(
      downlevelComponents('<Callout title="Heads up">Body.</Callout>\n')
    ).toBe("> **Heads up**\n>\n> Body.\n");
    expect(downlevelComponents("<Callout>Body.</Callout>\n")).toBe(
      "> **Info**\n>\n> Body.\n"
    );
  });

  it("renders a bare label when the callout has no body", () => {
    expect(downlevelComponents('<Callout type="tip" />\n')).toBe("> **Tip**\n");
  });

  it("downlevels components nested in the body", () => {
    const out = downlevelComponents(
      '<Callout type="note">\n  See this:\n\n  <YouTube id="dQw4w9WgXcQ" />\n</Callout>\n'
    );
    expect(out).toContain(
      "> [Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)"
    );
  });
});

describe("Steps", () => {
  it("renders an ordered list with bold titles and indented bodies", () => {
    const out = downlevelComponents(
      [
        "<Steps>",
        '  <Step title="Install">',
        "    Run the installer.",
        "",
        "    Then wait.",
        "  </Step>",
        '  <Step title="Verify">',
        "    Check `--version`.",
        "  </Step>",
        "</Steps>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      [
        "1. **Install**",
        "",
        "    Run the installer.",
        "",
        "    Then wait.",
        "",
        "2. **Verify**",
        "",
        "    Check `--version`.",
        "",
      ].join("\n")
    );
  });

  it("handles untitled and empty steps", () => {
    const out = downlevelComponents(
      '<Steps>\n  <Step>\n    Just do it.\n  </Step>\n  <Step title="Done" />\n</Steps>\n'
    );
    expect(out).toBe("1. Just do it.\n\n2. **Done**\n");
  });

  it("falls back to its body when it contains no Step children", () => {
    const out = downlevelComponents("<Steps>\n  Loose prose.\n</Steps>\n");
    expect(out).toBe("Loose prose.\n");
  });

  it("keeps nested components inside a step aligned with the item", () => {
    const out = downlevelComponents(
      [
        "<Steps>",
        '  <Step title="Watch">',
        '    <Callout type="tip" title="Shortcut">Use bun.</Callout>',
        "  </Step>",
        "</Steps>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      [
        "1. **Watch**",
        "",
        "    > **Shortcut**",
        "    >",
        "    > Use bun.",
        "",
      ].join("\n")
    );
  });
});

describe("Tabs", () => {
  it("renders each tab as a bold-labeled section", () => {
    const out = downlevelComponents(
      [
        "<Tabs>",
        '  <Tab title="npm">',
        "    `npm i blume`",
        "  </Tab>",
        '  <Tab title="bun">',
        "    `bun add blume`",
        "  </Tab>",
        "</Tabs>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      "**npm**\n\n`npm i blume`\n\n**bun**\n\n`bun add blume`\n"
    );
  });

  it("numbers untitled tabs and handles empty ones", () => {
    const out = downlevelComponents(
      '<Tabs>\n  <Tab>\n    First body.\n  </Tab>\n  <Tab title="named" />\n</Tabs>\n'
    );
    expect(out).toBe("**Tab 1**\n\nFirst body.\n\n**named**\n");
  });

  it("falls back to its body when it contains no Tab children", () => {
    const out = downlevelComponents("<Tabs>\n  Loose prose.\n</Tabs>\n");
    expect(out).toBe("Loose prose.\n");
  });
});

describe("YouTube", () => {
  it("links a bare id, honoring title and start", () => {
    expect(downlevelComponents('<YouTube id="dQw4w9WgXcQ" />\n')).toBe(
      "[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n"
    );
    expect(
      downlevelComponents(
        '<YouTube id="dQw4w9WgXcQ" title="Launch video" start={90.5} />\n'
      )
    ).toBe(
      "[Launch video](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s)\n"
    );
  });

  it("extracts the id from a full URL", () => {
    expect(
      downlevelComponents(
        '<YouTube url="https://youtu.be/dQw4w9WgXcQ?feature=share" />\n'
      )
    ).toBe("[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n");
  });

  it("stays verbatim when no video id can be resolved", () => {
    const source = '<YouTube url="https://example.com/not-a-video" />\n';
    expect(downlevelComponents(source)).toBe(source);
    const empty = "<YouTube />\n";
    expect(downlevelComponents(empty)).toBe(empty);
  });
});

describe("custom serializers", () => {
  it("downlevels a user component through its serializer", () => {
    const out = downlevelComponents(
      '# T\n\n<Chart title="Revenue" slug="rev" />\n',
      {
        Chart: ({ props }) =>
          `![${String(props.title)}](/charts/${String(props.slug)}.png)`,
      }
    );
    expect(out).toBe("# T\n\n![Revenue](/charts/rev.png)\n");
  });

  it("lets a same-name entry replace a built-in serializer", () => {
    const out = downlevelComponents('<Callout type="tip">Body.</Callout>\n', {
      Callout: ({ children }) => `NOTE: ${children}`,
    });
    expect(out).toBe("NOTE: Body.\n");
  });

  it("keeps the component verbatim when the serializer returns null", () => {
    const source = '<Callout type="tip">Body.</Callout>\n';
    expect(downlevelComponents(source, { Callout: () => null })).toBe(source);
  });

  it("receives downleveled children and extracted child components", () => {
    const out = downlevelComponents(
      [
        "<Gallery>",
        '  <Item caption="One">',
        '    <Callout type="note">Nested.</Callout>',
        "  </Item>",
        "</Gallery>",
        "",
      ].join("\n"),
      {
        Gallery: ({ childComponents }) =>
          childComponents("Item")
            .map((item) => `- ${String(item.props.caption)}: ${item.children}`)
            .join("\n"),
      }
    );
    expect(out).toBe("- One: > **Note**\n>\n> Nested.\n");
  });

  it("escapes regex metacharacters in component names", () => {
    // A name like `My$Chart` must not break the hint regex; it simply never
    // matches valid JSX, so the source is untouched.
    const source = "# Plain\n";
    expect(downlevelComponents(source, { My$Chart: () => "x" })).toBe(source);
  });
});

describe("attribute evaluation", () => {
  it("supports boolean shorthand and numeric expressions", () => {
    // `start={42}` is an expression; a bare attribute reads as `true` (and is
    // simply unused by the YouTube serializer).
    expect(
      downlevelComponents('<YouTube id="dQw4w9WgXcQ" muted start={42} />\n')
    ).toBe(
      "[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s)\n"
    );
  });

  it("treats unevaluable expressions as absent without failing the rest", () => {
    // Without page data passed, `frontmatter.title` can't resolve, so it
    // drops; the id still converts.
    expect(
      downlevelComponents(
        '<YouTube id="dQw4w9WgXcQ" title={frontmatter.title} />\n'
      )
    ).toBe("[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n");
  });
});

describe("frontmatter in scope", () => {
  it("resolves {frontmatter.*} expressions against the page data", () => {
    const out = downlevelComponents(
      '<YouTube id="dQw4w9WgXcQ" title={frontmatter.video_title} start={frontmatter.start} />\n',
      undefined,
      { start: 90, video_title: "Launch video" }
    );
    expect(out).toBe(
      "[Launch video](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s)\n"
    );
  });

  it("resolves compound expressions such as template literals", () => {
    const out = downlevelComponents(
      `<Callout title={\`Since v\${frontmatter.version}\`}>Body.</Callout>\n`,
      undefined,
      { version: 2 }
    );
    expect(out).toBe("> **Since v2**\n>\n> Body.\n");
  });

  it("treats a missing key as undefined, matching render-time semantics", () => {
    // `frontmatter.missing` is `undefined`, not an error: the prop is set but
    // empty, so the serializer's own default applies and nothing is lossy.
    const out = downlevelComponents(
      '<YouTube id="dQw4w9WgXcQ" title={frontmatter.missing} />\n',
      undefined,
      {}
    );
    expect(out).toBe(
      "[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n"
    );
  });

  it("still reports non-frontmatter scope as lossy", () => {
    const source = "<TypeTable type={imported.props} />\n";
    expect(downlevelComponents(source, undefined, { a: 1 })).toBe(source);
  });

  it("delivers frontmatter props to custom serializers (the #93 shape)", () => {
    const out = downlevelComponents(
      "<StatusBanner status={frontmatter.status} lastVerified={frontmatter.last_verified} />\n",
      {
        StatusBanner: ({ lossy, props }) =>
          lossy
            ? null
            : `> Status: ${String(props.status)} (verified ${String(props.lastVerified)})`,
      },
      { last_verified: "2026-07-01", status: "retracted" }
    );
    expect(out).toBe("> Status: retracted (verified 2026-07-01)\n");
  });

  it("exposes the page frontmatter on the serializer context", () => {
    const out = downlevelComponents(
      "<StatusBanner />\n",
      { StatusBanner: ({ frontmatter }) => `> ${String(frontmatter.status)}` },
      { status: "draft" }
    );
    expect(out).toBe("> draft\n");
  });

  it("defaults the context frontmatter to an empty object", () => {
    const out = downlevelComponents("<Probe />\n", {
      Probe: ({ frontmatter }) => `keys:${Object.keys(frontmatter).length}`,
    });
    expect(out).toBe("keys:0\n");
  });
});
