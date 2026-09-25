import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { join } from "pathe";
import { mdxToJs } from "satteri";
import type { MdastPluginDefinition } from "satteri";

import { directiveToCalloutPlugin } from "../src/markdown/directives.ts";
import { MDX_FEATURES } from "../src/markdown/features.ts";
import { blumeMdxProcessor } from "../src/markdown/index.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { force: true, recursive: true })));
});

/**
 * Render MDX through Blume's processor and return its HTML. `root` is the
 * content root and the page's folder, as a filesystem path — never derived
 * from the file URL's `pathname`, which reads `/C:/…` on Windows.
 */
const render = async (source: string, root?: string): Promise<string> => {
  const renderer = await blumeMdxProcessor({
    contentRoot: root,
  }).createRenderer({});
  const result = await renderer.render(source, {
    fileURL: root ? pathToFileURL(join(root, "page.mdx")) : undefined,
  });
  return result.code.trim();
};

// SAFETY: the same visitor-protocol bridge `markdown/index.ts` applies — the
// plugin's minimal node/context shapes narrow Satteri's own.
const asMdastPlugin = (plugin: { name: string }): MdastPluginDefinition =>
  plugin as MdastPluginDefinition;

/** Compile MDX with only the directive plugin, keeping `<Callout>` visible. */
const compileJsx = async (source: string): Promise<string> => {
  const { code } = await mdxToJs(source, {
    features: MDX_FEATURES,
    jsx: true,
    mdastPlugins: [asMdastPlugin(directiveToCalloutPlugin())],
  });
  return code;
};

describe("a container directive that isn't a callout", () => {
  it("renders its body between its fence lines, as written", async () => {
    const html = await render(
      "Before.\n\n:::details[Summary]{open}\nHidden **body** at 10:30.\n\n- item\n:::\n\nAfter.\n"
    );
    expect(html).toBe(
      [
        "<p>Before.</p>",
        "<p>:::details[Summary]{open}</p>",
        "<p>Hidden <strong>body</strong> at 10:30.</p>",
        "<ul>\n<li>item</li>\n</ul>",
        "<p>:::</p>",
        "<p>After.</p>",
      ].join("\n")
    );
  });

  it("keeps a misspelled callout's content", async () => {
    const html = await render(":::warnig\nKeep me.\n:::\n");
    expect(html).toBe("<p>:::warnig</p>\n<p>Keep me.</p>\n<p>:::</p>");
  });

  it("keeps a longer fence, and shows no closing line when unclosed", async () => {
    // A `:::` line can't close a `::::` container: it is the body's last line.
    const html = await render("::::aside\nBody.\n\n:::\n");
    expect(html).toBe("<p>::::aside</p>\n<p>Body.</p>\n<p>:::</p>");
    expect(await render("::::aside\nBody.\n\n::::\n")).toBe(
      "<p>::::aside</p>\n<p>Body.</p>\n<p>::::</p>"
    );
  });

  it("finds its closing fence inside a blockquote", async () => {
    const html = await render("> :::details\n> Quoted.\n> :::\n");
    expect(html).toContain("<p>:::details</p>\n<p>Quoted.</p>\n<p>:::</p>");
  });

  it("renders an empty one as its two fence lines", async () => {
    expect(await render(":::details\n:::\n")).toBe(
      "<p>:::details</p>\n<p>:::</p>"
    );
  });

  it("is rebuilt from its node when an include spliced it in", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-directive-containers-"));
    dirs.push(root);
    await writeFile(
      join(root, "part.mdx"),
      ":::details[Sum **up**]{open}\nPartial body.\n:::\n"
    );
    const html = await render("<include>./part.mdx</include>\n", root);
    expect(html).toContain(
      "<p>:::details[Sum up]{open}</p>\n<p>Partial body.</p>\n<p>:::</p>"
    );
  });
});

describe("nested container directives", () => {
  it("render a callout inside a callout", async () => {
    const code = await compileJsx(
      "::::note\nOuter.\n\n:::tip[Inner]\nInner body.\n:::\n::::\n"
    );
    expect(code).toContain('<Callout type="note">');
    expect(code).toContain('<Callout type="tip" title="Inner">');
    expect(code).toContain('{"Inner body."}');
  });

  it("keep an unknown container's body inside a callout, and a callout inside one", async () => {
    const code = await compileJsx(
      "::::note\n:::details\nIn a note.\n:::\n::::\n\n::::details\n:::tip\nIn details.\n:::\n::::\n"
    );
    expect(code).toContain(
      '<Callout type="note"><_components.p>{":::details"}</_components.p><_components.p>{"In a note."}</_components.p><_components.p>{":::"}</_components.p></Callout>'
    );
    expect(code).toContain('<_components.p>{"::::details"}</_components.p>');
    expect(code).toContain(
      '<Callout type="tip"><_components.p>{"In details."}</_components.p></Callout>'
    );
    expect(code).toContain('<_components.p>{"::::"}</_components.p>');
  });
});
