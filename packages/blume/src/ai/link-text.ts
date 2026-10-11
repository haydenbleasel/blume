/**
 * A title as Markdown link text. An unescaped bracket in it — `[Beta] Webhooks`
 * — closes or nests the text early, and the line stops being a link.
 */
export const linkText = (title: string): string =>
  title.replaceAll(/[\\[\]]/gu, String.raw`\$&`);
