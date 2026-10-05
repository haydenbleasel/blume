import { describe, expect, it } from "bun:test";

import {
  downlevelComponents,
  exampleComponentSerializers,
} from "../src/ai/component-markdown.ts";

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
    expect(out).toContain("| - | - | - | - |");
    expect(out).toContain("| `name` | `string` | - | The name. |");
    expect(out).toContain("| `size?` | `number` | `4` | |");
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
    expect(out).toContain("| `raw?` | `a` | - | |");
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
    expect(out).toMatch(/\| `a\?` \| `string` \| - \| \|\n\nExtra notes\./u);
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

describe("Card and CardGroup", () => {
  it("renders a card as a linked title over its body", () => {
    const out = downlevelComponents(
      '<Card title="Frontmatter" href="/reference/frontmatter" icon="file">\n  Page metadata: title, description, sidebar.\n</Card>\n'
    );
    expect(out).toBe(
      "**[Frontmatter](/reference/frontmatter)**\n\nPage metadata: title, description, sidebar.\n"
    );
  });

  it("keeps the call to action, after the body", () => {
    const out = downlevelComponents(
      '<Card title="Deploy" href="/deploy" cta="Read the guide">\n  Ship it.\n</Card>\n'
    );
    expect(out).toBe("**[Deploy](/deploy)**\n\nShip it.\n\nRead the guide\n");
  });

  it("bolds a card with no href, and escapes brackets in the label", () => {
    expect(
      downlevelComponents('<Card title="A [beta] card">\n  Body.\n</Card>\n')
    ).toBe("**A [beta] card**\n\nBody.\n");
    expect(
      downlevelComponents(
        '<Card title="A [beta] card" href="/b">\n  Body.\n</Card>\n'
      )
    ).toBe("**[A \\[beta\\] card](/b)**\n\nBody.\n");
  });

  it("stringifies a numeric title, rather than dropping it for the href", () => {
    expect(
      downlevelComponents('<Card title={2024} href="/y">\n  Year.\n</Card>\n')
    ).toBe("**[2024](/y)**\n\nYear.\n");
  });

  it("falls back to the href when there is no title", () => {
    expect(
      downlevelComponents('<Card href="/pricing">\n  What it costs.\n</Card>\n')
    ).toBe("**[/pricing](/pricing)**\n\nWhat it costs.\n");
  });

  it("is just its body when it carries neither title nor href", () => {
    expect(
      downlevelComponents('<Card icon="file">\n  Only a blurb.\n</Card>\n')
    ).toBe("Only a blurb.\n");
  });

  it("keeps the call to action on a card with no title or href", () => {
    expect(
      downlevelComponents('<Card cta="Read the guide">\n  A blurb.\n</Card>\n')
    ).toBe("A blurb.\n\nRead the guide\n");
  });

  it("wraps an href that would end its own link destination", () => {
    // Whitespace ends a destination, and so does an unbalanced `)`.
    expect(
      downlevelComponents(
        '<Card title="Docs" href="/docs/page)notes">\n  Body.\n</Card>\n'
      )
    ).toBe("**[Docs](</docs/page)notes>)**\n\nBody.\n");
    expect(
      downlevelComponents(
        '<Card title="Docs" href="/docs/my page">\n  Body.\n</Card>\n'
      )
    ).toBe("**[Docs](</docs/my page>)**\n\nBody.\n");
  });

  it("reduces a self-closing card to its heading", () => {
    expect(downlevelComponents('<Card title="Foo" href="/x" />\n')).toBe(
      "**[Foo](/x)**\n"
    );
  });

  it("downlevels a nested group through the outer one", () => {
    const out = downlevelComponents(
      [
        "<CardGroup>",
        "  <CardGroup>",
        '    <Card title="Inner" href="/i">In.</Card>',
        "  </CardGroup>",
        "</CardGroup>",
        "",
      ].join("\n")
    );
    expect(out).toBe("**[Inner](/i)**\n\nIn.\n");
  });

  it("keeps a card with nothing but presentation verbatim", () => {
    const source = '<Card icon="file" img="/shot.png" />\n';
    expect(downlevelComponents(source)).toBe(source);
  });

  it("declines when a prop did not evaluate, rather than link somewhere wrong", () => {
    const source = '<Card title={pageTitle()} href="/a">\n  Body.\n</Card>\n';
    expect(downlevelComponents(source)).toBe(source);
  });

  it("unwraps a group to the cards it holds", () => {
    const out = downlevelComponents(
      [
        "<CardGroup cols={2}>",
        '  <Card title="One" href="/one">',
        "    First.",
        "  </Card>",
        '  <Card title="Two" href="/two">',
        "    Second.",
        "  </Card>",
        "</CardGroup>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      "**[One](/one)**\n\nFirst.\n\n**[Two](/two)**\n\nSecond.\n"
    );
  });

  it("keeps a declining card as its own block beside a good one", () => {
    // The declining card's JSX stands as a block of its own — a blank line
    // between, so it does not continue the rendered card's paragraph.
    const out = downlevelComponents(
      [
        "<CardGroup>",
        '  <Card title="Good" href="/a">',
        "    Body A.",
        "  </Card>",
        '  <Card title={dynamic()} href="/b">',
        "    Body B.",
        "  </Card>",
        "</CardGroup>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      '**[Good](/a)**\n\nBody A.\n\n<Card title={dynamic()} href="/b">\n  Body B.\n</Card>\n'
    );
  });

  it("renders the cards in a group through a user `Card` override", () => {
    const out = downlevelComponents(
      [
        "<CardGroup>",
        '  <Card title="One" href="/one">First.</Card>',
        '  <Card title="Two" href="/two">Second.</Card>',
        "</CardGroup>",
        "",
      ].join("\n"),
      { Card: ({ props }) => `- ${String(props.title)}` }
    );
    expect(out).toBe("- One\n\n- Two\n");
  });

  it("keeps prose and a nested group beside the cards a group holds", () => {
    const out = downlevelComponents(
      [
        "<CardGroup>",
        "  Pick one:",
        "",
        '  <Card title="A" href="/a">A body.</Card>',
        "  <CardGroup>",
        '    <Card title="B" href="/b">B body.</Card>',
        "  </CardGroup>",
        '  <Widget name="sparkles" />',
        "</CardGroup>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      'Pick one:\n\n**[A](/a)**\n\nA body.\n\n**[B](/b)**\n\nB body.\n\n<Widget name="sparkles" />\n'
    );
  });

  it("falls back to its body when no card in it could be serialized", () => {
    // The group unwraps, but a card whose props did not evaluate keeps its
    // own JSX — the same fallback `<Tabs>` takes with no `<Tab>` in it.
    const out = downlevelComponents(
      [
        "<CardGroup>",
        '  <Card title={a()} href="/a">',
        "    First.",
        "  </Card>",
        "</CardGroup>",
        "",
      ].join("\n")
    );
    expect(out).toBe('<Card title={a()} href="/a">\n  First.\n</Card>\n');
  });

  it("keeps a group's content when it holds no cards", () => {
    expect(
      downlevelComponents("<CardGroup>\n  Loose prose.\n</CardGroup>\n")
    ).toBe("Loose prose.\n");
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

  it("leaves a body expression as written; only props resolve", () => {
    // The docs say so: `{frontmatter.owner}` in the page's text isn't a prop,
    // so the Markdown copy keeps it verbatim.
    const out = downlevelComponents(
      "Owned by {frontmatter.owner}.\n\n<Callout title={frontmatter.owner}>Body.</Callout>\n",
      undefined,
      { owner: "Platform" }
    );
    expect(out).toBe(
      "Owned by {frontmatter.owner}.\n\n> **Platform**\n>\n> Body.\n"
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

describe("exampleComponentSerializers (<Component> downleveling)", () => {
  const examples = exampleComponentSerializers({
    "forms/login": {
      lang: "tsx",
      source: "export const Login = () => null;\n",
    },
  });

  it("downlevels a <Component> to its example source as a fenced block", () => {
    const out = downlevelComponents(
      '## Preview\n\n<Component path="forms/login" />\n',
      examples
    );
    expect(out).toBe(
      "## Preview\n\n```tsx\nexport const Login = () => null;\n```\n"
    );
  });

  it("leaves an unknown example path verbatim", () => {
    const source = '<Component path="forms/missing" />\n';
    expect(downlevelComponents(source, examples)).toBe(source);
  });

  it("leaves a <Component> with no path prop verbatim", () => {
    const source = "<Component />\n";
    expect(downlevelComponents(source, examples)).toBe(source);
  });

  it("lets a user markdownComponents override win over the example serializer", () => {
    const out = downlevelComponents('<Component path="forms/login" />\n', {
      ...examples,
      Component: ({ props }) => `see \`${String(props.path)}\``,
    });
    expect(out).toBe("see `forms/login`\n");
  });

  it("widens the fence when the example source contains a triple backtick", () => {
    const withTicks = exampleComponentSerializers({
      md: { lang: "md", source: "```ts\nconst x = 1;\n```\n" },
    });
    const out = downlevelComponents('<Component path="md" />\n', withTicks);
    expect(out).toBe("````md\n```ts\nconst x = 1;\n```\n````\n");
  });
});

// Every built-in with no serializer used to reach agents as raw JSX; each
// now renders the information its component shows.
const md = (lines: string[]): string =>
  downlevelComponents(`${lines.join("\n")}\n`);

describe("layout and disclosure components", () => {
  it("opens an accordion into its items' titles and bodies", () => {
    expect(
      md([
        "<Accordion>",
        '  <AccordionItem title="Is it free?" description="Pricing">',
        "    Yes.",
        "  </AccordionItem>",
        "  <AccordionItem>No title.</AccordionItem>",
        "</Accordion>",
      ])
    ).toBe("**Is it free?**\n\nPricing\n\nYes.\n\nNo title.\n");
    expect(md(["<AccordionItem title={t()}>X</AccordionItem>"])).toBe(
      "<AccordionItem title={t()}>X</AccordionItem>\n"
    );
  });

  it("opens an expandable, titled or with the default title", () => {
    expect(
      md(['<Expandable title="Details">', "  More.", "</Expandable>"])
    ).toBe("**Details**\n\nMore.\n");
    expect(md(["<Expandable>", "  More.", "</Expandable>"])).toBe(
      "**Show more**\n\nMore.\n"
    );
  });

  it("unwraps file trees, columns, and code groups to their contents", () => {
    expect(md(["<FileTree>", "- docs/", "  - index.md", "</FileTree>"])).toBe(
      "- docs/\n  - index.md\n"
    );
    expect(
      md([
        "<Columns cols={2}>",
        "  <Column>Left.</Column>",
        "  <Column>Right.</Column>",
        "</Columns>",
      ])
    ).toBe("Left.\n\nRight.\n");
    expect(
      md([
        "<CodeGroup>",
        '```ts title="a.ts"',
        "const a = 1;",
        "```",
        "",
        '```ts title="b.ts"',
        "const b = 2;",
        "```",
        "</CodeGroup>",
      ])
    ).toBe(
      '```ts title="a.ts"\nconst a = 1;\n```\n\n```ts title="b.ts"\nconst b = 2;\n```\n'
    );
  });

  it("keeps a frame's hint, slot, and caption, and a panel's title", () => {
    expect(
      md([
        '<Frame hint="Above." caption="The **dashboard**.">',
        "  ![Dashboard](/d.png)",
        "</Frame>",
      ])
    ).toBe("Above.\n\n![Dashboard](/d.png)\n\nThe **dashboard**.\n");
    expect(md(['<Panel title="Aside">', "  Note.", "</Panel>"])).toBe(
      "**Aside**\n\nNote.\n"
    );
    expect(md(["<Panel>Untitled.</Panel>"])).toBe("Untitled.\n");
  });

  it("links a tile like a card", () => {
    expect(
      md(['<Tile title="Guides" href="/guides" description="Start here." />'])
    ).toBe("**[Guides](/guides)**\n\nStart here.\n");
    expect(md(['<Tile title="Plain">Preview.</Tile>'])).toBe(
      "**Plain**\n\nPreview.\n"
    );
    expect(md(["<Tile />"])).toBe("<Tile />\n");
    expect(md(["<Tile title={t()} />"])).toBe("<Tile title={t()} />\n");
  });

  it("heads an update with its label, linked when it has a page", () => {
    expect(
      md([
        '<Update label="v2.0" description="Big one" tags={["major", "api"]}>',
        "  Notes.",
        "</Update>",
      ])
    ).toBe("**v2.0**\n\nBig one\n\nTags: major, api\n\nNotes.\n");
    expect(
      md(['<Update title="Launch" href="/changelog/launch" tags="news" />'])
    ).toBe("**[Launch](/changelog/launch)**\n\nTags: news\n");
    expect(md(["<Update />"])).toBe("**Update**\n");
    expect(md(["<Update label={l()} />"])).toBe("<Update label={l()} />\n");
  });

  it("quotes a prompt under its description", () => {
    expect(
      md([
        '<Prompt description="Add a page">',
        "  Write a quickstart.",
        "",
        "  Keep it short.",
        "</Prompt>",
      ])
    ).toBe("**Add a page**\n\n> Write a quickstart.\n>\n> Keep it short.\n");
    expect(md(["<Prompt />"])).toBe("**Prompt**\n");
  });
});

describe("data and inline components", () => {
  it("links a GitHub card to its repository", () => {
    expect(md(['<GithubInfo owner="acme" repo="sdk" />'])).toBe(
      "[acme/sdk](https://github.com/acme/sdk)\n"
    );
    expect(
      md([
        '<GithubInfo owner="acme" repo="sdk" host="https://git.acme.dev/" />',
      ])
    ).toBe("[acme/sdk](https://git.acme.dev/acme/sdk)\n");
    expect(md(['<GithubInfo owner="acme" />'])).toBe(
      '<GithubInfo owner="acme" />\n'
    );
    expect(md(['<GithubInfo owner={o()} repo="sdk" />'])).toBe(
      '<GithubInfo owner={o()} repo="sdk" />\n'
    );
  });

  it("fences a code block, keeping its title", () => {
    expect(md(['<CodeBlock code="let a = 1" lang="ts" title="a.ts" />'])).toBe(
      '```ts title="a.ts"\nlet a = 1\n```\n'
    );
    expect(md(['<CodeBlock code="plain" />'])).toBe("```txt\nplain\n```\n");
    expect(md(["<CodeBlock code={c()} />"])).toBe("<CodeBlock code={c()} />\n");
  });

  it("fences a diff from a patch or its two sides, never from files", () => {
    expect(md(['<Diff patch="-a\\n+b" />'])).toBe("```diff\n-a\\n+b\n```\n");
    expect(md(['<Diff old="a" new="b" lang="ts" />'])).toBe(
      "**Before**\n\n```ts\na\n```\n\n**After**\n\n```ts\nb\n```\n"
    );
    expect(md(['<Diff src="./change.patch" />'])).toBe(
      '<Diff src="./change.patch" />\n'
    );
    expect(md(["<Diff patch={p()} />"])).toBe("<Diff patch={p()} />\n");
  });

  it("keeps math as TeX, inline or displayed", () => {
    expect(md(['<Math code="x^2" display />'])).toBe("$$\nx^2\n$$\n");
    expect(md(['Area is <Math code="\\pi r^2" /> exactly.'])).toBe(
      "Area is $\\pi r^2$ exactly.\n"
    );
    expect(md(["<Math code={c()} />"])).toBe("<Math code={c()} />\n");
  });

  it("drops a decorative icon, keeps a labeled one's label, and unwraps a badge", () => {
    expect(md(['Status <Icon name="check" /> done.'])).toBe("Status  done.\n");
    expect(md(['<Icon name="check" label="Supported" />'])).toBe("Supported\n");
    expect(md(["Now <Badge>Beta</Badge> in the SDK."])).toBe(
      "Now Beta in the SDK.\n"
    );
  });

  it("spells out a tooltip's tip after its trigger", () => {
    expect(
      md([
        'Uses <Tooltip headline="SSR" tip="Rendered per request">server output</Tooltip> here.',
      ])
    ).toBe("Uses server output (SSR: Rendered per request) here.\n");
    expect(md(['<Tooltip tip="Only a tip" />'])).toBe("Only a tip\n");
    expect(md(["<Tooltip>No tip</Tooltip>"])).toBe(
      "<Tooltip>No tip</Tooltip>\n"
    );
    expect(md(["<Tooltip tip={t()}>X</Tooltip>"])).toBe(
      "<Tooltip tip={t()}>X</Tooltip>\n"
    );
  });

  it("draws a tree as the nested list it renders", () => {
    expect(
      md([
        "<Tree>",
        '  <Tree.Folder name="src">',
        '    <Tree.Folder name="empty" />',
        '    <Tree.File name="index.ts" />',
        "  </Tree.Folder>",
        '  <Tree.File name="README.md" />',
        "</Tree>",
      ])
    ).toBe("- src/\n  - empty/\n  - index.ts\n- README.md\n");
    expect(md(["<Tree.Folder>X</Tree.Folder>"])).toBe(
      "<Tree.Folder>X</Tree.Folder>\n"
    );
    expect(md(["<Tree.File />"])).toBe("<Tree.File />\n");
  });

  it("lists a palette's colors by name and value", () => {
    expect(
      md([
        "<Color>",
        '  <Color.Row title="Brand">',
        '    <Color.Item name="Accent" value="#2563eb" />',
        '    <Color.Item name="Surface" value={{ light: "#ffffff", dark: "#0a0a0a" }} />',
        '    <Color.Item name="Ink" value={{ dark: "#111111" }} />',
        '    <Color.Item name="Same" value={{ light: "#000000", dark: "#000000" }} />',
        "  </Color.Row>",
        "</Color>",
      ])
    ).toBe(
      "**Brand**\n\n- **Accent**: `#2563eb`\n- **Surface**: `#ffffff` (light), `#0a0a0a` (dark)\n- **Ink**: `#111111`\n- **Same**: `#000000`\n"
    );
    for (const value of ["{[1]}", "{new Date(0)}", "{{}}"]) {
      const item = `<Color.Item name="X" value=${value} />`;
      expect(md([item])).toBe(`${item}\n`);
    }
    expect(md(['<Color.Item value="#fff" />'])).toBe(
      '<Color.Item value="#fff" />\n'
    );
  });
});

describe("nested content under a component", () => {
  it("keeps a nested list's indentation inside an indented body", () => {
    const out = downlevelComponents(
      [
        "<Steps>",
        '  <Step title="Install">',
        "    - macOS",
        "      - brew install acme",
        "    - Linux",
        "  </Step>",
        "</Steps>",
        "",
      ].join("\n")
    );
    expect(out).toBe(
      "1. **Install**\n\n    - macOS\n      - brew install acme\n    - Linux\n"
    );
  });
});
