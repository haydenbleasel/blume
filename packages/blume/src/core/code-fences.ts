/**
 * Fenced-code state for line scanners. Kept free of imports so request-time
 * code (the assistant's grounding excerpts) can share it with the build-time source
 * scanners without pulling the filesystem and schema modules along.
 *
 * CommonMark allows backtick *and* tilde fences, three or more characters
 * long. The scanners track which delimiter opened the current fence and how
 * long its run was (`null` when outside one), so a ``` line inside a ~~~
 * block — or inside a ````-delimited block (the wrapper `codeBlockLines`
 * emits around code that contains its own ``` fence) — is content, not a
 * toggle.
 *
 * MDX scanners can also ask for block math, which MDX parses by the same
 * rules: two or more `$` open it, and its content is never Markdown or MDX.
 */
const CODE_FENCE = /^(?<run>`{3,}|~{3,})/u;
const CODE_OR_MATH_FENCE = /^(?<run>`{3,}|~{3,}|\${2,})/u;

// One block-quote marker. A fence inside a quote (`> ```ts`) is written after
// one marker per level of nesting, and so is every line of its code.
const QUOTE_MARKER = /^[ \t]*>/u;

/**
 * The open fence's delimiter char, its run length, and the block-quote depth
 * it opened at, or null outside one.
 */
export type FenceState = {
  delimiter: "`" | "~" | "$";
  length: number;
  quotes: number;
} | null;

/** The character a fence's run is made of. */
const delimiterOf = (run: string): NonNullable<FenceState>["delimiter"] => {
  if (run.startsWith("`")) {
    return "`";
  }
  return run.startsWith("$") ? "$" : "~";
};

/** Strip up to `max` leading block-quote markers from `line`. */
const stripQuotes = (line: string, max: number) => {
  let rest = line;
  let depth = 0;
  while (depth < max) {
    const marker = QUOTE_MARKER.exec(rest);
    if (!marker) {
      break;
    }
    rest = rest.slice(marker[0].length);
    depth += 1;
  }
  return { depth, rest };
};

/**
 * Advance the fenced-code state for one line: an opening fence records its
 * delimiter and run length, only a bare run of the same character at least as
 * long closes it (CommonMark), and any other line leaves the state untouched.
 * A fence inside block quotes is read past the quote markers it opened under,
 * and a line without them ends the quote, and the fence with it: code takes
 * no lazy continuation lines (CommonMark). With `math`, a `$$` block math
 * fence counts too.
 */
export const nextFenceState = (
  line: string,
  fence: FenceState,
  math = false
): FenceState => {
  const { depth, rest } = stripQuotes(
    line,
    fence === null ? Number.POSITIVE_INFINITY : fence.quotes
  );
  if (fence !== null && depth < fence.quotes) {
    return nextFenceState(line, null, math);
  }
  const trimmed = rest.trimStart();
  const run = trimmed.match(math ? CODE_OR_MATH_FENCE : CODE_FENCE)?.groups
    ?.run;
  if (run === undefined) {
    return fence;
  }
  const info = trimmed.slice(run.length);
  const delimiter = delimiterOf(run);
  if (fence === null) {
    // A backtick fence's info string cannot itself contain a backtick
    // (CommonMark), nor a math fence's a `$` — a line-leading ```inline```
    // span or `$$x$$` is a paragraph, and opening a phantom fence on it would
    // swallow every heading and link after it. Tilde fences carry no such
    // rule.
    if (delimiter !== "~" && info.includes(delimiter)) {
      return fence;
    }
    return { delimiter, length: run.length, quotes: depth };
  }
  // A closing fence may be followed only by whitespace: a same-length
  // ```js line inside an open ``` block is content, not a closer.
  return fence.delimiter === delimiter &&
    run.length >= fence.length &&
    info.trim() === ""
    ? null
    : fence;
};
