import stringWidth from "string-width";

/**
 * The longest prefix of `text` that renders within `max` display columns
 * without cutting inside a grapheme cluster. Columns are `string-width`'s: a
 * fullwidth or wide character counts 2, a combining mark 0, everything else 1
 * — the same measure `blume audit` grades titles and meta descriptions with,
 * so text cut here stays inside the audit's thresholds for every script, not
 * just Latin. Grapheme segmentation is rule-based (UAX #29), so unlike word
 * segmentation it does not drift across ICU builds, and it can never split a
 * surrogate pair or halve an emoji sequence.
 */
export const columnsPrefix = (text: string, max: number): string => {
  let end = 0;
  let used = 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { index, segment } of graphemes.segment(text)) {
    const width = stringWidth(segment);
    if (used + width > max) {
      break;
    }
    used += width;
    end = index + segment.length;
  }
  return text.slice(0, end);
};
