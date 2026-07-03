import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import type {
  CalloutRewriteOptions,
  LiteralValue,
} from "../src/migrate/shared.ts";
import {
  asLiteralArray,
  asLiteralString,
  attribute,
  ensurePackageJson,
  findOpenTagEnd,
  findStringEnd,
  isLiteralObject,
  leftoverFiles,
  parseKey,
  parseLiteral,
  readString,
  renameTag,
  rewriteCallouts,
  rewriteFrameworkScripts,
  scanArray,
  scanObject,
  splitKeyValue,
  stripJsComments,
  stripUnknownPageMeta,
  unescapeString,
  UNPARSEABLE,
  writeBlumeConfig,
} from "../src/migrate/shared.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "blume-shared-"));
  dirs.push(dir);
  return dir;
};

const calloutOptions: CalloutRewriteOptions = {
  defaultDirective: "note",
  tagDirectives: { Warning: "warning" },
  tags: ["Callout", "Warning"],
  typeDirectives: { info: "info", tip: "tip" },
};

describe("writeBlumeConfig", () => {
  it("serializes a config to a defineConfig module", async () => {
    const root = await tempDir();
    await writeBlumeConfig(root, { description: "Hi", title: "Docs Test" });

    const written = await readFile(join(root, "blume.config.ts"), "utf-8");
    expect(written).toContain('import { defineConfig } from "blume";');
    expect(written).toContain("export default defineConfig(");
    expect(written).toContain('"title": "Docs Test"');
    expect(written).toContain('"description": "Hi"');
    expect(written.endsWith(");\n")).toBe(true);
  });
});

describe("rewriteFrameworkScripts", () => {
  it("repoints dev/build/start at Blume and drops framework-only scripts", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          build: "next build",
          dev: "next dev",
          lint: "eslint .",
          postinstall: "fumadocs-mdx",
          start: "next start",
        },
      }),
      "utf-8"
    );

    expect(await rewriteFrameworkScripts(root, /\bnext\b/u, /fumadocs/u)).toBe(
      true
    );
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf-8")
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts).toEqual({
      build: "blume build",
      dev: "blume dev",
      lint: "eslint .",
      start: "blume preview",
    });
  });

  it("is a no-op when no script invokes the framework", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "blume dev" } }),
      "utf-8"
    );
    expect(await rewriteFrameworkScripts(root, /\bnext\b/u)).toBe(false);
  });
});

describe("leftoverFiles", () => {
  it("returns only the candidate paths that exist", async () => {
    const root = await tempDir();
    await writeFile(join(root, "next.config.ts"), "", "utf-8");
    expect(leftoverFiles(root, ["next.config.ts", "source.config.ts"])).toEqual(
      ["next.config.ts"]
    );
  });
});

describe("ensurePackageJson", () => {
  it("scaffolds a runnable package.json when none exists", async () => {
    const root = await tempDir();
    expect(await ensurePackageJson(root)).toBe(true);

    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.dev).toBe("blume dev");
    expect(pkg.dependencies.blume).toMatch(/^\^\d/u);
  });

  it("leaves an existing package.json untouched", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "existing" }),
      "utf-8"
    );
    expect(await ensurePackageJson(root)).toBe(false);

    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf-8")
    ) as { name: string; scripts?: unknown };
    expect(pkg.name).toBe("existing");
    expect(pkg.scripts).toBeUndefined();
  });
});

describe("attribute", () => {
  it("reads a double-quoted attribute value", () => {
    expect(attribute('title="Hello"', "title")).toBe("Hello");
  });

  it("reads a single-quoted attribute value", () => {
    expect(attribute("title='Hi there'", "title")).toBe("Hi there");
  });

  it("returns undefined when the attribute is absent", () => {
    expect(attribute('other="x"', "title")).toBeUndefined();
  });
});

describe("findOpenTagEnd", () => {
  it("finds the closing angle bracket of a plain tag", () => {
    expect(findOpenTagEnd('a="b">rest', 0)).toBe(5);
  });

  it("ignores a > inside a double-quoted attribute", () => {
    expect(findOpenTagEnd('a="x>y">', 0)).toBe(7);
  });

  it("ignores a > inside a brace expression", () => {
    expect(findOpenTagEnd("icon={a>b}>", 0)).toBe(10);
  });

  it("ignores a > inside a template literal", () => {
    expect(findOpenTagEnd("x=`a>b`>", 0)).toBe(7);
  });

  it("treats an escaped quote as still inside the string", () => {
    expect(findOpenTagEnd('a="x\\"y">', 0)).toBe(8);
  });

  it("returns -1 for an unterminated tag", () => {
    expect(findOpenTagEnd("no closing bracket", 0)).toBe(-1);
  });
});

describe("rewriteCallouts", () => {
  it("converts a tag-directed callout", () => {
    expect(rewriteCallouts("<Warning>Risky</Warning>", calloutOptions)).toBe(
      ":::warning\nRisky\n:::"
    );
  });

  it("converts a type-directed callout", () => {
    expect(
      rewriteCallouts('<Callout type="info">Context</Callout>', calloutOptions)
    ).toBe(":::info\nContext\n:::");
  });

  it("uses the default directive when no type is present", () => {
    expect(rewriteCallouts("<Callout>Body</Callout>", calloutOptions)).toBe(
      ":::note\nBody\n:::"
    );
  });

  it("adds the title to the directive head", () => {
    expect(
      rewriteCallouts(
        '<Warning title="Heads up">Risky</Warning>',
        calloutOptions
      )
    ).toBe(":::warning[Heads up]\nRisky\n:::");
  });

  it("dedents indented multi-line callout bodies", () => {
    const input = "<Callout>\n  line1\n  line2\n</Callout>";
    expect(rewriteCallouts(input, calloutOptions)).toBe(
      ":::note\nline1\nline2\n:::"
    );
  });

  it("handles an empty callout body without throwing", () => {
    expect(rewriteCallouts("<Callout></Callout>", calloutOptions)).toBe(
      ":::note\n\n:::"
    );
  });

  it("converts a self-closing callout with a title", () => {
    expect(
      rewriteCallouts('<Callout type="info" title="Hi" />', calloutOptions)
    ).toBe(":::info[Hi]\n:::");
  });

  it("converts a self-closing callout without a title", () => {
    expect(rewriteCallouts("<Warning />", calloutOptions)).toBe(
      ":::warning\n:::"
    );
  });

  it("leaves a callout with an unknown type untouched", () => {
    const input = '<Callout type="mystery">Body</Callout>';
    expect(rewriteCallouts(input, calloutOptions)).toBe(input);
  });

  it("leaves an unterminated open tag untouched", () => {
    const input = '<Callout type="info"';
    expect(rewriteCallouts(input, calloutOptions)).toBe(input);
  });

  it("leaves a tag with a valid directive but no closing tag untouched", () => {
    const input = '<Callout type="info">unterminated body';
    expect(rewriteCallouts(input, calloutOptions)).toBe(input);
  });

  it("passes through text with no callouts", () => {
    expect(rewriteCallouts("just prose", calloutOptions)).toBe("just prose");
  });

  it("converts multiple callouts and preserves surrounding text", () => {
    const input = 'A <Warning>w</Warning> B <Callout type="tip">t</Callout> C';
    expect(rewriteCallouts(input, calloutOptions)).toBe(
      "A :::warning\nw\n::: B :::tip\nt\n::: C"
    );
  });

  it("converts a callout nested inside a different callout", () => {
    const input =
      '<Warning>\nCareful\n\n<Callout type="info">nested</Callout>\n\nhere\n</Warning>';
    // The inner callout converts too, and the outer fence grows so the inner
    // ::: doesn't close it.
    expect(rewriteCallouts(input, calloutOptions)).toBe(
      "::::warning\nCareful\n\n:::info\nnested\n:::\n\nhere\n::::"
    );
  });

  it("closes same-tag nesting at the outer close tag", () => {
    const input = "<Callout>a\n<Callout>b</Callout>\nc</Callout>";
    expect(rewriteCallouts(input, calloutOptions)).toBe(
      "::::note\na\n:::note\nb\n:::\nc\n::::"
    );
  });

  it("does not count a nested self-closing tag as an open", () => {
    const input = "<Callout>a <Warning /> b</Callout>";
    expect(rewriteCallouts(input, calloutOptions)).toBe(
      "::::note\na :::warning\n::: b\n::::"
    );
  });
});

describe("stripUnknownPageMeta", () => {
  it("returns valid data unchanged with nothing removed", () => {
    const { data, removed } = stripUnknownPageMeta({ title: "Page" });
    expect(removed).toEqual([]);
    expect(data).toEqual({ title: "Page" });
  });

  it("drops stray root-level keys the strict schema rejects", () => {
    const { data, removed } = stripUnknownPageMeta({
      "og:locale": "en_US",
      title: "Page",
      "twitter:card": "summary",
    });
    expect(removed.toSorted()).toEqual(["og:locale", "twitter:card"]);
    expect(data).toEqual({ title: "Page" });
  });

  it("leaves non-unrecognized-key validation errors for dev to surface", () => {
    const input = { title: 123 };
    const { data, removed } = stripUnknownPageMeta(input);
    expect(removed).toEqual([]);
    expect(data).toBe(input);
  });
});

describe("renameTag", () => {
  it("renames open and close tags while keeping attributes", () => {
    expect(renameTag('<Card title="x">y</Card>', "Card", "Box")).toBe(
      '<Box title="x">y</Box>'
    );
  });

  it("does not rename a longer tag sharing the prefix", () => {
    const input = "<CardGrid>z</CardGrid>";
    expect(renameTag(input, "Card", "Box")).toBe(input);
  });
});

describe("findStringEnd", () => {
  it("finds the matching closing quote", () => {
    expect(findStringEnd('"abc"', 0)).toBe(4);
  });

  it("skips escaped characters", () => {
    expect(findStringEnd('"a\\"b"', 0)).toBe(5);
  });

  it("works with single quotes", () => {
    expect(findStringEnd("'x'", 0)).toBe(2);
  });

  it("returns -1 when the string is unterminated", () => {
    expect(findStringEnd('"abc', 0)).toBe(-1);
  });
});

describe("unescapeString", () => {
  it("unescapes newlines", () => {
    expect(unescapeString("a\\nb")).toBe("a\nb");
  });

  it("unescapes tabs", () => {
    expect(unescapeString("a\\tb")).toBe("a\tb");
  });

  it("unescapes a quote to its literal character", () => {
    expect(unescapeString('a\\"b')).toBe('a"b');
  });

  it("unescapes a backslash to a single backslash", () => {
    expect(unescapeString("a\\\\b")).toBe("a\\b");
  });
});

describe("scanObject", () => {
  it("splits top-level key/value entries and reports the close index", () => {
    const result = scanObject("{a: 1, b: 2}", 0);
    expect(result?.entries).toEqual(["a: 1", "b: 2"]);
    expect(result?.end).toBe(11);
  });

  it("does not split on commas inside strings", () => {
    const result = scanObject('{a: "x, y"}', 0);
    expect(result?.entries).toEqual(['a: "x, y"']);
  });

  it("does not split on commas inside nested braces or brackets", () => {
    const result = scanObject("{a: { x: 1, y: 2 }, b: [1, 2]}", 0);
    expect(result?.entries.length).toBe(2);
  });

  it("does not split on commas inside a block comment", () => {
    const result = scanObject("{a: /* x, y */ 1}", 0);
    expect(result?.entries.length).toBe(1);
  });

  it("does not split on commas inside a line comment", () => {
    const result = scanObject("{a: 1 // c\n}", 0);
    expect(result?.entries).toEqual(["a: 1 // c"]);
  });

  it("treats a slash that is not a comment as ordinary text", () => {
    const result = scanObject("{a: 1/2}", 0);
    expect(result?.entries).toEqual(["a: 1/2"]);
  });

  it("returns null for an unterminated object", () => {
    expect(scanObject("{a: 1", 0)).toBeNull();
  });

  it("returns null when a line comment runs to end of input", () => {
    expect(scanObject("{a: 1 //c", 0)).toBeNull();
  });

  it("returns null when a block comment is never closed", () => {
    expect(scanObject("{a: 1 /*c", 0)).toBeNull();
  });

  it("returns null when a string runs to end of input", () => {
    expect(scanObject('{a: "unclosed', 0)).toBeNull();
  });
});

describe("scanArray", () => {
  it("splits top-level elements and reports the close index", () => {
    const result = scanArray("[1, 2, 3]", 0);
    expect(result?.elements).toEqual(["1", "2", "3"]);
    expect(result?.end).toBe(8);
  });

  it("ignores a trailing comma", () => {
    const result = scanArray("[1, 2,]", 0);
    expect(result?.elements).toEqual(["1", "2"]);
  });

  it("does not split on nested commas", () => {
    const result = scanArray("[[1, 2], {a: 1}]", 0);
    expect(result?.elements.length).toBe(2);
  });

  it("does not split on commas inside a block comment", () => {
    const result = scanArray("[/* a, b */ 1, 2]", 0);
    expect(result?.elements.length).toBe(2);
  });

  it("returns null for an unterminated array", () => {
    expect(scanArray("[1, 2", 0)).toBeNull();
  });
});

describe("stripJsComments", () => {
  it("removes a trailing line comment", () => {
    expect(stripJsComments('const x = "a//b"; // tail')).toBe(
      'const x = "a//b"; '
    );
  });

  it("replaces a block comment with a single space", () => {
    expect(stripJsComments("a /* c */ b")).toBe("a   b");
  });

  it("preserves an escaped quote inside a string", () => {
    expect(stripJsComments('"a\\"b" // c')).toBe('"a\\"b" ');
  });

  it("keeps text up to an unterminated block comment", () => {
    const out = stripJsComments("a /* unclosed");
    expect(out).toBe("a  ");
    expect(out).not.toContain("unclosed");
  });
});

describe("splitKeyValue", () => {
  it("splits a plain key/value entry", () => {
    expect(splitKeyValue("key: value")).toEqual({ key: "key", value: "value" });
  });

  it("skips leading whitespace", () => {
    expect(splitKeyValue("   key: value")).toEqual({
      key: "key",
      value: "value",
    });
  });

  it("allows whitespace before the colon", () => {
    expect(splitKeyValue("key : value")).toEqual({
      key: "key",
      value: "value",
    });
  });

  it("reads a quoted key verbatim", () => {
    expect(splitKeyValue('"my key": value')).toEqual({
      key: '"my key"',
      value: "value",
    });
  });

  it("returns null for a computed key", () => {
    expect(splitKeyValue("[expr]: value")).toBeNull();
  });

  it("returns null for an unterminated quoted key", () => {
    expect(splitKeyValue('"unclosed : value')).toBeNull();
  });

  it("returns an empty value when there is no colon", () => {
    expect(splitKeyValue("bareKey")).toEqual({ key: "bareKey", value: "" });
  });
});

describe("parseKey", () => {
  it("returns a bare identifier key unchanged", () => {
    expect(parseKey("foo")).toBe("foo");
  });

  it("unquotes a string-literal key", () => {
    expect(parseKey('"foo bar"')).toBe("foo bar");
  });

  it("unescapes inside a quoted key", () => {
    expect(parseKey('"a\\nb"')).toBe("a\nb");
  });

  it("falls back to the trimmed text for an unterminated quoted key", () => {
    expect(parseKey('"unclosed')).toBe('"unclosed');
  });
});

describe("readString", () => {
  it("reads a clean double-quoted string", () => {
    expect(readString('"hi"')).toBe("hi");
  });

  it("reads a template literal with no interpolation", () => {
    expect(readString("`plain`")).toBe("plain");
  });

  it("unescapes inside the string", () => {
    expect(readString('"a\\nb"')).toBe("a\nb");
  });

  it("returns null for a non-string value", () => {
    expect(readString("identifier")).toBeNull();
  });

  it("returns null for an interpolated template literal", () => {
    expect(readString(`\`a\${b}\``)).toBeNull();
  });

  it("returns null for an unterminated string", () => {
    expect(readString('"unclosed')).toBeNull();
  });

  it("returns null when there is trailing content after the string", () => {
    expect(readString('"a" + b')).toBeNull();
  });
});

describe("parseLiteral", () => {
  it("returns UNPARSEABLE for an empty source", () => {
    expect(parseLiteral("")).toBe(UNPARSEABLE);
    expect(parseLiteral("   ")).toBe(UNPARSEABLE);
  });

  it("parses string literals", () => {
    expect(parseLiteral('"hi"')).toBe("hi");
  });

  it("returns UNPARSEABLE for a string expression", () => {
    expect(parseLiteral('"a" + b')).toBe(UNPARSEABLE);
  });

  it("parses boolean and null scalars", () => {
    expect(parseLiteral("true")).toBe(true);
    expect(parseLiteral("false")).toBe(false);
    expect(parseLiteral("null")).toBeNull();
  });

  it("parses numbers", () => {
    expect(parseLiteral("42")).toBe(42);
    expect(parseLiteral("-3.14")).toBe(-3.14);
  });

  it("returns UNPARSEABLE for identifiers and malformed numbers", () => {
    expect(parseLiteral("someIdent")).toBe(UNPARSEABLE);
    expect(parseLiteral("12abc")).toBe(UNPARSEABLE);
  });

  it("parses object literals", () => {
    expect(parseLiteral('{ a: 1, b: "x", c: true }')).toEqual({
      a: 1,
      b: "x",
      c: true,
    });
  });

  it("keeps UNPARSEABLE object values for the caller to drop", () => {
    const result = parseLiteral("{a: foo()}");
    expect(isLiteralObject(result)).toBe(true);
    if (isLiteralObject(result)) {
      expect(result.a).toBe(UNPARSEABLE);
    }
  });

  it("drops object entries with no value", () => {
    expect(parseLiteral("{a: 1, bare}")).toEqual({ a: 1 });
  });

  it("returns UNPARSEABLE for an unterminated or trailing object", () => {
    expect(parseLiteral("{a: 1")).toBe(UNPARSEABLE);
    expect(parseLiteral("{a: 1} extra")).toBe(UNPARSEABLE);
  });

  it("parses array literals", () => {
    expect(parseLiteral('[1, "two", false]')).toEqual([1, "two", false]);
  });

  it("keeps UNPARSEABLE array elements in position", () => {
    const result = parseLiteral("[1, foo, 3]");
    const array = asLiteralArray(result);
    expect(array).toEqual([1, UNPARSEABLE, 3]);
  });

  it("returns UNPARSEABLE for an unterminated or trailing array", () => {
    expect(parseLiteral("[1, 2")).toBe(UNPARSEABLE);
    expect(parseLiteral("[1] x")).toBe(UNPARSEABLE);
  });

  it("parses nested objects and arrays", () => {
    expect(parseLiteral("{ a: [1, { b: 2 }] }")).toEqual({
      a: [1, { b: 2 }],
    });
  });
});

describe("literal narrowers", () => {
  const missing: LiteralValue | undefined = undefined;

  it("narrows strings with asLiteralString", () => {
    expect(asLiteralString("hi")).toBe("hi");
    expect(asLiteralString(5)).toBeUndefined();
    expect(asLiteralString(missing)).toBeUndefined();
    expect(asLiteralString(UNPARSEABLE)).toBeUndefined();
  });

  it("narrows plain objects with isLiteralObject", () => {
    expect(isLiteralObject({ a: 1 })).toBe(true);
    expect(isLiteralObject([1])).toBe(false);
    expect(isLiteralObject(null)).toBe(false);
    expect(isLiteralObject("s")).toBe(false);
    expect(isLiteralObject(missing)).toBe(false);
    expect(isLiteralObject(UNPARSEABLE)).toBe(false);
  });

  it("narrows arrays with asLiteralArray", () => {
    expect(asLiteralArray([1, 2])).toEqual([1, 2]);
    expect(asLiteralArray({ a: 1 })).toBeUndefined();
    expect(asLiteralArray("x")).toBeUndefined();
    expect(asLiteralArray(missing)).toBeUndefined();
  });
});
