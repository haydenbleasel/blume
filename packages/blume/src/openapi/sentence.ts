/**
 * A sentence's closing punctuation, allowing trailing closing quotes or
 * brackets (`…done.")`) and the CJK full-width marks.
 */
const TERMINAL_PUNCTUATION = /[.!?…。！？]["'”’)\]]*$/u;

/**
 * A colon closing the fragment introduces a list or block it was cut from
 * ("Supports two modes:" before its bullets). The ASCII or full-width colon,
 * with the space French typesetting puts before it ("Deux modes :").
 */
const LEAD_IN_COLON = /\s*[:：]\s*$/u;

/**
 * A trailing colon that belongs to a literal rather than the prose: an emoji
 * shortcode (`:rocket:`) or a `Foo::` scope.
 */
const LITERAL_COLON = /(?:[:：]{2}|:[\w+-]+:)\s*$/u;

/** Whether `text` ends in a colon that leads in to what follows it. */
export const endsInLeadIn = (text: string): boolean =>
  LEAD_IN_COLON.test(text) && !LITERAL_COLON.test(text);

/**
 * Close prose with a period unless it already ends a sentence. A colon at the
 * end is kept and gains the period: use this when the caller has already told
 * a lead-in apart from a literal (`tenant:` in inline code). Empty text stays
 * empty.
 */
export const closeSentence = (text: string): string =>
  text === "" || TERMINAL_PUNCTUATION.test(text) ? text : `${text}.`;

/**
 * Close a fragment of spec prose as a sentence. OpenAPI `summary` values are
 * usually title-like ("Get a flag", no period), so prose that runs straight
 * into the next generated sentence ("Get a flag Reference for …") needs one.
 * A lead-in colon becomes the period rather than gaining one after it, and
 * prose that already ended before it ("e.g.:") keeps its own mark.
 */
export const asSentence = (text: string): string =>
  closeSentence(endsInLeadIn(text) ? text.replace(LEAD_IN_COLON, "") : text);
