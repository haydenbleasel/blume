import baseMatter from "gray-matter";
import { dump, load } from "js-yaml";

import { YAML_SCHEMA } from "./yaml.ts";

// gray-matter@4 binds js-yaml 3's `safeLoad`/`safeDump` as its default YAML
// engine. In a workspace that resolves a newer js-yaml for gray-matter — v4
// replaced those functions with throwing stubs, v5 dropped them — parsing
// front matter throws "Function yaml.safeLoad is removed in js-yaml 4." Every
// Blume front-matter call routes through this `matter` wrapper, which supplies
// an explicit engine built on Blume's own `load`/`dump`, so Blume is immune to
// whichever version the consumer's install resolves for gray-matter.

type MatterInput = Parameters<typeof baseMatter>[0];
type MatterOptions = Parameters<typeof baseMatter>[1];
type ReadArgs = Parameters<typeof baseMatter.read>;
type StringifyArgs = Parameters<typeof baseMatter.stringify>;

/** Front matter data as gray-matter types it (`GrayMatterFile["data"]`). */
type FrontMatterData = ReturnType<typeof baseMatter>["data"];

/** A YAML load result: a mapping (or list) Astro keeps as front matter data. */
const isYamlCollection = (
  value: ReturnType<typeof load>
): value is FrontMatterData => typeof value === "object" && value !== null;

const yamlEngine = {
  // A block that loads to a scalar (`title` alone, or prose between two
  // `---` lines) is no metadata: Astro reads it as `{}`, and so does Blume.
  parse: (input: string): FrontMatterData => {
    const value = load(input, { schema: YAML_SCHEMA });
    return isYamlCollection(value) ? value : {};
  },
  stringify: (data: FrontMatterData): string => dump(data),
};

const withYamlEngine = <O extends { engines?: object } | undefined>(
  options: O
): O =>
  // SAFETY: the spread keeps every field of `options`; adding a default yaml
  // engine (overridden by any caller-supplied `engines`) stays within O's
  // shape — TS just can't prove a spread of a generic re-satisfies O.
  ({
    ...options,
    engines: {
      yaml: yamlEngine,
      ...options?.engines,
    },
  }) as O;

/**
 * True when a document's leading `---` line is a CommonMark thematic break,
 * not a front matter fence: no closing `---` line follows. Astro's own front
 * matter match requires that close too, while gray-matter would swallow the
 * whole document as one unclosed YAML block and hand it to js-yaml, which
 * crashes on ordinary Markdown (`> quote` → "a line break is expected").
 *
 * A blank line after the opening `---` is still front matter: Astro strips
 * the block from the page either way, so reading it as a divider here would
 * ignore its `draft`, `slug`, and `hidden` while its YAML leaked into search
 * and llms.txt.
 */
const opensWithThematicBreak = (input: string): boolean => {
  const [first = ""] = input.split(/\r?\n/u, 1);
  if (!/^-{3}\s*$/u.test(first)) {
    return false;
  }
  // gray-matter closes the block at the next line-leading `---`; matching its
  // search exactly keeps this guard from firing on any document it parses.
  return !input.includes("\n---", 1);
};

/**
 * gray-matter's runtime result carries `isEmpty`, which its declared
 * GrayMatterFile type omits.
 */
interface MatterResult extends ReturnType<typeof baseMatter> {
  isEmpty: boolean;
}

/**
 * The parse result for a document with no front matter: the input passes
 * through as content, untouched. Shaped like gray-matter's own no-matter
 * result (every Blume call site reads only `content` and `data`).
 */
const passthrough = (input: string): ReturnType<typeof baseMatter> => {
  const file: MatterResult = {
    content: input,
    data: {},
    excerpt: "",
    isEmpty: false,
    language: "",
    matter: "",
    orig: input,
    // Recomposing a file with no matter and empty data is the content itself.
    stringify: (): string => input,
  };
  return file;
};

/** Narrows gray-matter's input union to the raw-string form. */
const isStringInput = (input: MatterInput): input is string =>
  typeof input === "string";

// Every helper that parses or emits YAML (`read`, `stringify`) must be
// re-wrapped here — Object.assign copies gray-matter's own helpers, which use
// its default `safeLoad` engine and would reintroduce the crash. `test` only
// checks for a delimiter, so the copied original is safe.
const matter = Object.assign(
  (input: MatterInput, options?: MatterOptions) =>
    isStringInput(input) && opensWithThematicBreak(input)
      ? passthrough(input)
      : baseMatter(input, withYamlEngine(options)),
  baseMatter,
  {
    read: (filepath: ReadArgs[0], options?: ReadArgs[1]) =>
      baseMatter.read(filepath, withYamlEngine(options)),
    // A string is the body to emit, not a document to parse: gray-matter
    // would otherwise run `matter()` over it, and a body that opens with a
    // `---` divider reads as a second front matter block — js-yaml either
    // throws or swallows the opening paragraph into the YAML header.
    stringify: (
      file: StringifyArgs[0],
      data: StringifyArgs[1],
      options?: StringifyArgs[2]
    ): string =>
      baseMatter.stringify(
        isStringInput(file) ? { content: file } : file,
        data,
        withYamlEngine(options)
      ),
  }
);

export default matter;
