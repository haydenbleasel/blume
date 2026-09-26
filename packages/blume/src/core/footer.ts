/**
 * The social platforms `footer.socials` links to, each shown by its brand
 * icon: Mintlify's set, without its aliases (`twitter` and `x-twitter` are
 * `x`, `earth-americas` is `website`).
 */
export const FOOTER_SOCIALS = [
  "bluesky",
  "discord",
  "facebook",
  "github",
  "hacker-news",
  "instagram",
  "linkedin",
  "medium",
  "podcast",
  "reddit",
  "slack",
  "telegram",
  "threads",
  "website",
  "x",
  "youtube",
] as const;

/** A platform `footer.socials` links to. */
export type FooterSocial = (typeof FOOTER_SOCIALS)[number];
