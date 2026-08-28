/**
 * Color classes shared by every component that draws a label over a tint of
 * its own hue — method badges, response status chips, `<Badge>`, the sidebar's
 * method badges — and by the typed callout/card icons. One table so the pairs
 * can't drift between components.
 *
 * Contrast rule (light mode): text over a 15% tint of its hue must clear 4.5:1,
 * the WCAG AA bar for text this size. `-700` does for most hues; green and
 * orange need `-800`, the way yellow already does over its 20% tint. Dark mode
 * clears the bar at `-300` throughout. Check any hue added here.
 */

export type Hue =
  | "blue"
  | "green"
  | "orange"
  | "purple"
  | "red"
  | "teal"
  | "violet"
  | "yellow";

/** Label over a translucent tint of the same hue. */
export const TINT = {
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  green: "bg-green-500/15 text-green-800 dark:text-green-300",
  orange: "bg-orange-500/15 text-orange-800 dark:text-orange-300",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  yellow: "bg-yellow-500/20 text-yellow-800 dark:text-yellow-300",
} satisfies Record<Hue, string>;

/**
 * Label with a translucent border of the same hue and no fill. The label
 * inherits whatever surface it sits on (a callout, a card, the muted panel), so
 * it is held to the same values as `TINT`: green at `-700` is 4.47:1 on the
 * default muted surface.
 */
export const STROKE = {
  blue: "border-blue-500/40 text-blue-700 dark:text-blue-300",
  green: "border-green-500/40 text-green-800 dark:text-green-300",
  orange: "border-orange-500/40 text-orange-800 dark:text-orange-300",
  purple: "border-purple-500/40 text-purple-700 dark:text-purple-300",
  red: "border-red-500/40 text-red-700 dark:text-red-300",
  teal: "border-teal-500/40 text-teal-700 dark:text-teal-300",
  violet: "border-violet-500/40 text-violet-700 dark:text-violet-300",
  yellow: "border-yellow-500/40 text-yellow-800 dark:text-yellow-300",
} satisfies Record<Hue, string>;

/** The neutral fallback every table falls through to. */
export const MUTED = "bg-muted text-muted-foreground";

/**
 * HTTP methods, AsyncAPI actions, and GraphQL root-field kinds, as shown on an
 * operation's badge and in a reference's sidebar. Type-page kinds fall through
 * to the muted default so operation badges stay the loud ones.
 */
export const METHOD_COLORS = {
  DELETE: TINT.red,
  GET: TINT.green,
  HEAD: MUTED,
  MUTATION: TINT.blue,
  OPTIONS: MUTED,
  PATCH: TINT.yellow,
  POST: TINT.blue,
  PUT: TINT.orange,
  QUERY: TINT.green,
  RECEIVE: TINT.teal,
  SEND: TINT.violet,
  SUBSCRIPTION: TINT.violet,
} satisfies Record<string, string>;

const isMethod = (key: string): key is keyof typeof METHOD_COLORS =>
  Object.hasOwn(METHOD_COLORS, key);

export const methodColor = (method: string): string => {
  const key = method.toUpperCase();
  return isMethod(key) ? METHOD_COLORS[key] : MUTED;
};

/** Response status chips, by the status code's class. */
export const statusColor = (status: string): string => {
  if (status.startsWith("2")) {
    return TINT.green;
  }
  if (status.startsWith("3")) {
    return TINT.blue;
  }
  if (status.startsWith("4")) {
    return TINT.orange;
  }
  if (status.startsWith("5")) {
    return TINT.red;
  }
  return MUTED;
};

/**
 * The small `deprecated` label beside an operation's path or field name. It
 * draws on the page background, where orange needs `-700` for 4.5:1.
 */
export const DEPRECATED_LABEL_CLASS =
  "font-medium text-[0.625rem] text-orange-700 uppercase tracking-wide dark:text-orange-400";

/** The typed admonitions `<Callout>` and `<Card>` render; `check` is an alias of `success`. */
export type AdmonitionType =
  | "info"
  | "note"
  | "tip"
  | "success"
  | "warning"
  | "danger";

export const admonitionType = (
  type: AdmonitionType | "check"
): AdmonitionType => (type === "check" ? "success" : type);

export const ADMONITION_ICON = {
  danger: "circle-x",
  info: "info",
  note: "info",
  success: "circle-check",
  tip: "lightbulb",
  warning: "triangle-alert",
} satisfies Record<AdmonitionType, string>;

/**
 * An admonition's icon names its type, so it is meaningful UI held to the 3:1
 * non-text bar against the tint behind it: green and amber need `-700` over
 * their 10% tint, and the note icon is full-strength muted-foreground (at 70%
 * it fell under the bar on the muted surface).
 */
export const ADMONITION_ICON_CLASS = {
  danger: "text-red-600 dark:text-red-400",
  info: "text-blue-600 dark:text-blue-400",
  note: "text-muted-foreground",
  success: "text-green-700 dark:text-green-400",
  tip: "text-accent",
  warning: "text-amber-700 dark:text-amber-400",
} satisfies Record<AdmonitionType, string>;
