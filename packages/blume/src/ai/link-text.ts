/** `encodeURIComponent` leaves these as they are, so they're mapped here. */
const UNESCAPED = new Map([
  ["'", "%27"],
  ["(", "%28"],
  [")", "%29"],
]);

/**
 * A link target with the characters `chars` matches percent-encoded: ones
 * that would end or split a Markdown link destination or the attribute it's
 * in (whitespace, parentheses, quotes). The rest stays as written, so
 * `/ja/ポイント` reads as it is.
 */
export const encodeTargetChars = (target: string, chars: RegExp): string =>
  target.replaceAll(
    chars,
    (char) => UNESCAPED.get(char) ?? encodeURIComponent(char)
  );

/**
 * A page route as a link target in the assistant's snapshot, which the model
 * cites as written: whitespace, parentheses, and a `%` (which would read as
 * an escape) are percent-encoded.
 */
export const routeTarget = (route: string): string =>
  encodeTargetChars(route, /[%\s()]/gu);

/**
 * A title as Markdown link text. An unescaped bracket in it — `[Beta] Webhooks`
 * — closes or nests the text early, and the line stops being a link; so does a
 * line break, which a folded YAML title (`title: >`) ends with, so whitespace
 * runs collapse to one space.
 */
export const linkText = (title: string): string =>
  title
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/[\\[\]]/gu, String.raw`\$&`);
