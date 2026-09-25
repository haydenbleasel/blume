import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";
import { mdxToJs } from "satteri";
import type { MdastPluginDefinition } from "satteri";

import { directiveToCalloutPlugin } from "../src/markdown/directives.ts";
import { MDX_FEATURES } from "../src/markdown/features.ts";
import {
  blumeMarkdownProcessor,
  blumeMdxProcessor,
} from "../src/markdown/index.ts";
import type { MdastNode } from "../src/markdown/mdast.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

/** Render a source through a Blume processor and return its HTML. */
const render = async (
  processor: ReturnType<typeof blumeMdxProcessor>,
  source: string,
  fileURL?: URL
): Promise<string> => {
  const renderer = await processor.createRenderer({});
  const result = await renderer.render(source, { fileURL });
  return result.code;
};

/**
 * Compile MDX with only the directive plugin, keeping the JSX, so a
 * `<Callout>` (which the HTML renderer has no component for) shows its props
 * and children.
 */
// SAFETY: the same visitor-protocol bridge `markdown/index.ts` applies — the
// plugin's minimal node/context shapes narrow Satteri's own.
const asMdastPlugin = (plugin: { name: string }): MdastPluginDefinition =>
  plugin as MdastPluginDefinition;

const compileJsx = async (source: string): Promise<string> => {
  const { code } = await mdxToJs(source, {
    features: MDX_FEATURES,
    jsx: true,
    mdastPlugins: [asMdastPlugin(directiveToCalloutPlugin())],
  });
  return code;
};

describe("text and leaf directives Blume doesn't handle", () => {
  it("render as the text the author wrote in .mdx", async () => {
    const cases = [
      ["a responsive 16:9 frame", "16:9 frame"],
      ["a dead og:image renders", "og:image renders"],
      ["Starts at 10:30am.", "10:30am"],
      ["Status:done here", "Status:done here"],
      ["Grant the pets:read scope.", "pets:read scope"],
    ];
    const rendered = await Promise.all(
      cases.map(([source]) => render(blumeMdxProcessor({}), source ?? ""))
    );
    for (const [index, [, expected]] of cases.entries()) {
      expect(rendered[index]).toContain(expected ?? "");
    }
  });

  it("keeps a label and attributes exactly as written", async () => {
    const html = await render(
      blumeMdxProcessor({}),
      "See :abbr[**HTML**]{title='x' #y .z} here."
    );
    expect(html).toContain("See :abbr[**HTML**]{title='x' #y .z} here.");
  });

  it("renders a leaf directive as a paragraph of its source", async () => {
    const html = await render(blumeMdxProcessor({}), "::youtube[x]{id=1}");
    expect(html).toContain("<p>::youtube[x]{id=1}</p>");
  });

  it("keeps a heading's text and anchor whole", async () => {
    const html = await render(blumeMdxProcessor({}), "## Office at 12:45pm");
    expect(html).toContain('id="office-at-1245pm"');
    expect(html).toContain("Office at 12:45pm");
  });

  it("leaves plain .md alone — it has no directives", async () => {
    const html = await render(
      blumeMarkdownProcessor({}),
      "A 16:9 frame at 10:30am, ::youtube[x]{id=1}"
    );
    expect(html).toContain("A 16:9 frame at 10:30am, ::youtube[x]{id=1}");
  });

  it("rebuilds a directive spliced in by an include from its node", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-directive-literals-"));
    dirs.push(root);
    // An included partial carries no offsets into the including page, so
    // the literal is rebuilt from the parsed node: the name, the label's
    // text, and each attribute (a value-less one as a bare key).
    await writeFile(
      join(root, "part.mdx"),
      "Partial at 10:30am, :x[**lab**]{k=v flag} and ::\n\n::embed[clip]{id=7}\n"
    );
    const html = await render(
      blumeMdxProcessor({ contentRoot: root }),
      "<include>./part.mdx</include>\n",
      pathToFileURL(join(root, "page.mdx"))
    );
    expect(html).toContain('Partial at 10:30am, :x[lab]{k="v" flag} and ::');
    expect(html).toContain('<p>::embed[clip]{id="7"}</p>');
  });
});

describe("directiveToCalloutPlugin text visitor", () => {
  it("rebuilds a directive whose offsets don't point at it in the source", () => {
    // Offsets rebased onto other text (a spliced subtree) must not be
    // trusted: the slice here is `zz`, not the directive.
    let replacement: MdastNode | MdastNode[] | undefined;
    directiveToCalloutPlugin().textDirective(
      {
        name: "x",
        position: { end: { offset: 2 }, start: { offset: 0 } },
        type: "textDirective",
      },
      {
        parent: () => {},
        replaceNode: (_node, value) => {
          replacement = value;
        },
        source: "zz",
      }
    );
    expect(replacement).toStrictEqual({ type: "text", value: ":x" });
  });
});

describe("container directives", () => {
  it("still render a callout, with directives in its title and body literal", async () => {
    const code = await compileJsx(
      ":::note[Meet at 10:30]\nBody at **11:00** ok\n\n::youtube[x]{id=1}\n:::"
    );
    expect(code).toContain('<Callout type="note" title="Meet at 10:30">');
    // The body keeps its formatting, with the directive text back in place.
    expect(code).toContain(
      '<_components.strong>{"11"}{":00"}</_components.strong>'
    );
    expect(code).toContain('<_components.p>{"::youtube[x]{id=1}"}');
  });

  it("only leave a text directive to the container that renders it", async () => {
    // The text directive visitor renders the directive before the container
    // itself, walking past its paragraph to the root; the one inside
    // `:::details` was rendered with the container's body.
    const code = await compileJsx("Before 9:15.\n\n:::details\nAt 10:30\n:::");
    expect(code).toContain('{"Before 9"}{":15"}');
    expect(code).toContain('{"At 10"}{":30"}');
  });
});
