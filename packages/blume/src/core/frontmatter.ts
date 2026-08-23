import baseMatter from "gray-matter";
import { dump, load } from "js-yaml";

// gray-matter@4 binds js-yaml 3's `safeLoad`/`safeDump` as its default YAML
// engine. In a workspace that pins js-yaml to v4 — where those functions were
// removed — parsing front matter throws "Function yaml.safeLoad is removed in
// js-yaml 4." Every Blume front-matter call routes through this `matter`
// wrapper, which supplies an explicit engine built on `load`/`dump`. Both exist
// in js-yaml 3 and 4, so Blume is immune to whichever version the consumer's
// install resolves for gray-matter.

type MatterInput = Parameters<typeof baseMatter>[0];
type MatterOptions = Parameters<typeof baseMatter>[1];
type ReadArgs = Parameters<typeof baseMatter.read>;
type StringifyArgs = Parameters<typeof baseMatter.stringify>;

/** Front matter data as gray-matter types it (`GrayMatterFile["data"]`). */
type FrontMatterData = ReturnType<typeof baseMatter>["data"];

const yamlEngine = {
  // SAFETY: gray-matter's engine contract expects an object; a front matter
  // block is a YAML mapping, and js-yaml returns a scalar only for degenerate
  // input, which gray-matter treats the same way its bundled engine's output
  // is treated.
  parse: (input: string): object => (load(input) ?? {}) as object,
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
 * not a front matter fence. Two shapes qualify (mirroring
 * `linesWithoutFrontMatter` in `sources/normalize.ts`):
 *   - the next line is blank (or absent) — YAML metadata starts on the very
 *     next line, so a gap means the body *opens* with a divider (e.g. a
 *     Notion page whose first block is one);
 *   - no closing `---` line follows — gray-matter would swallow the whole
 *     document as one unclosed YAML block and hand it to js-yaml, which
 *     crashes on ordinary Markdown (`> quote` → "a line break is expected").
 */
const opensWithThematicBreak = (input: string): boolean => {
  const [first = "", second] = input.split(/\r?\n/u, 2);
  if (!/^-{3}\s*$/u.test(first)) {
    return false;
  }
  if (second === undefined || second.trim() === "") {
    return true;
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
