import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { join } from "pathe";

import { BUILTIN_CHILD_PROPS } from "../src/core/builtin-tags.ts";
import { extractElementUses, parseMdxBody } from "../src/core/mdx-elements.ts";
import { normalizeEntry } from "../src/core/sources/normalize.ts";

/**
 * The props a content component declares: its `interface Props` members, or
 * else the names it destructures from `Astro.props`.
 */
const declaredProps = (tag: string): string[] => {
  const source = readFileSync(
    join(import.meta.dir, "../src/components/content", `${tag}.astro`),
    "utf-8"
  );
  const [, frontmatter = ""] = source.split("---");
  const members = /interface Props \{(?<body>[\s\S]*?)\n\}/u.exec(frontmatter)
    ?.groups?.body;
  if (members !== undefined) {
    return [...members.matchAll(/^ {2}(?<name>\w+)\??:/gmu)].map(
      (match) => match.groups?.name ?? ""
    );
  }
  const names =
    /const \{(?<names>[^}]*)\} = Astro\.props/u.exec(frontmatter)?.groups
      ?.names ?? "";
  return names
    .split(",")
    .map((part) => part.trim().split(/[\s:=]/u)[0] ?? "")
    .filter(Boolean);
};

describe("BUILTIN_CHILD_PROPS", () => {
  it("matches the props each component declares", () => {
    for (const [tag, props] of BUILTIN_CHILD_PROPS) {
      expect({ props: declaredProps(tag).toSorted(), tag }).toStrictEqual({
        props: [...props],
        tag,
      });
    }
  });
});

describe("extractElementUses", () => {
  it("finds JavaScript handlers on HTML elements, at their line", () => {
    const body = [
      '<button onClick={() => alert("hi")} onMouseEnter={open}>Click</button>',
      "",
      'Inline <span onFocus={handler} onclick="run()">x</span>.',
    ].join("\n");
    expect(extractElementUses(body, 4)).toStrictEqual([
      {
        column: 1,
        kind: "handler",
        line: 5,
        props: ["onClick", "onMouseEnter"],
        tag: "button",
      },
      { column: 8, kind: "handler", line: 7, props: ["onFocus"], tag: "span" },
    ]);
  });

  it("leaves string handlers, components, and member elements alone", () => {
    const quiet = [
      '<button onClick="go()" onKeyDown={"go()"}>x</button>\n',
      "<motion.div onClick={() => 1} />\n",
      "<Counter onClick={() => 1} />\n",
      "```mdx\n<button onClick={() => 1}>x</button>\n```\n",
    ];
    for (const body of quiet) {
      expect(extractElementUses(body)).toStrictEqual([]);
    }
  });

  it("finds a childless built-in given props it doesn't take", () => {
    const body = [
      '<Badge type="tip" text="beta" />',
      "",
      'Inline <Badge variant="accent" text="x"> </Badge> and <Badge text="y">ok</Badge>.',
      "",
      '<CodeBlock language="ts" filename="a.ts" />',
      "",
      "<Column wide />",
    ].join("\n");
    expect(extractElementUses(body)).toStrictEqual([
      {
        column: 1,
        kind: "prop",
        line: 1,
        props: ["type", "text"],
        tag: "Badge",
      },
      { column: 8, kind: "prop", line: 3, props: ["text"], tag: "Badge" },
      {
        column: 1,
        kind: "prop",
        line: 5,
        props: ["language", "filename"],
        tag: "CodeBlock",
      },
      { column: 1, kind: "prop", line: 7, props: ["wide"], tag: "Column" },
    ]);
  });

  it("leaves known props, spreads, directives, and other components alone", () => {
    const quiet = [
      '<Badge variant="success" />\n',
      '<Callout title="Heads up" client:load set:html={x} />\n',
      '<Card title="t" {...props} extra="y" />\n',
      '<YouTube id="dQw4w9WgXcQ" foo="x" />\n',
      // MDX can't parse the page, which fails with its own error.
      '<Badge text="x" />\n\n<button onClick={() => 1}>Unclosed\n',
    ];
    for (const body of quiet) {
      expect(extractElementUses(body)).toStrictEqual([]);
    }
  });
});

describe(parseMdxBody, () => {
  it("parses a body once, however many walks read it", () => {
    const body = '<Steps title="x" />\n';
    const tree = parseMdxBody(body);
    expect(tree?.type).toBe("root");
    expect(parseMdxBody(body)).toBe(tree);
    expect(parseMdxBody("Other.\n")).not.toBe(tree);
  });

  it("gives null for a body MDX can't parse", () => {
    expect(parseMdxBody("<div>Unclosed\n")).toBeNull();
  });
});

describe("normalizeEntry event handlers", () => {
  const ctx = {
    defaultType: "doc",
    source: { name: "docs", staged: false },
  };

  it("warns about a handler, at its line in the page or its partial", () => {
    const body = "Intro.\n\n<button onClick={() => go()}>Go</button>\n";
    const { diagnostics, pages } = normalizeEntry(
      {
        body: { format: "mdx", text: body },
        data: { title: "Guide" },
        raw: `---\ntitle: Guide\n---\n${body}`,
        ref: "guide.mdx",
        sourcePath: "/docs/guide.mdx",
      },
      ctx
    );
    expect(diagnostics).toStrictEqual([
      {
        code: "BLUME_MDX_EVENT_HANDLER",
        column: 1,
        file: "/docs/guide.mdx",
        line: 6,
        message:
          "`onClick` on `<button>` is a JavaScript function, which a static page never runs.",
        severity: "warning",
        suggestion:
          "Move the interactive markup into an island (islands/Name.tsx), which runs in the browser, and use that component in the page.",
      },
    ]);
    expect(pages[0]?.unknownProps).toBeUndefined();

    const partial = normalizeEntry(
      {
        body: { format: "mdx", text: "<include>./_part.mdx</include>\n" },
        data: {},
        expanded: {
          includes: ["/docs/_part.mdx"],
          origins: [{ file: "/docs/_part.mdx", line: 2 }],
          text: "<div onClick={a} onBlur={b}>x</div>\n",
        },
        ref: "page.mdx",
        sourcePath: undefined,
      },
      ctx
    );
    expect(partial.diagnostics).toMatchObject([
      {
        file: "/docs/_part.mdx",
        line: 2,
        message:
          "`onClick` and `onBlur` on `<div>` are JavaScript functions, which a static page never runs.",
      },
    ]);
  });

  it("records a childless built-in's unknown props on the page", () => {
    const { diagnostics, pages } = normalizeEntry(
      {
        body: { format: "mdx", text: '<Badge text="beta" />\n' },
        data: {},
        ref: "remote.mdx",
      },
      ctx
    );
    expect(diagnostics).toStrictEqual([]);
    expect(pages[0]?.unknownProps).toStrictEqual([
      { column: 1, kind: "prop", line: 1, props: ["text"], tag: "Badge" },
    ]);
  });

  it("names a remote entry's handler by its source and ref", () => {
    const { diagnostics } = normalizeEntry(
      {
        body: { format: "mdx", text: "<a onClick={go}>x</a>\n" },
        data: {},
        ref: "remote.mdx",
      },
      ctx
    );
    expect(diagnostics[0]?.file).toBe("docs:remote.mdx");
  });
});
