import {
  siBluesky,
  siDiscord,
  siFacebook,
  siGithub,
  siInstagram,
  siMedium,
  siReddit,
  siTelegram,
  siThreads,
  siX,
  siYcombinator,
  siYoutube,
} from "simple-icons";

import type { FooterSocial } from "../../core/footer.ts";

/**
 * How a `footer.socials` platform is shown: its name, for the link's label,
 * and either a filled brand mark or a Lucide icon.
 */
export interface SocialIcon {
  label: string;
  /** A Lucide icon name, where simple-icons carries no mark for the brand. */
  icon?: string;
  /** A simple-icons path on a 24×24 viewBox, drawn filled. */
  path?: string;
}

/**
 * Each platform's icon. Brand marks come from simple-icons; LinkedIn and
 * Slack had theirs removed there at the brands' request, so they take
 * Lucide's glyphs, as do the generic website and podcast links.
 */
export const SOCIAL_ICONS: Record<FooterSocial, SocialIcon> = {
  bluesky: { label: "Bluesky", path: siBluesky.path },
  discord: { label: "Discord", path: siDiscord.path },
  facebook: { label: "Facebook", path: siFacebook.path },
  github: { label: "GitHub", path: siGithub.path },
  "hacker-news": { label: "Hacker News", path: siYcombinator.path },
  instagram: { label: "Instagram", path: siInstagram.path },
  linkedin: { icon: "linkedin", label: "LinkedIn" },
  medium: { label: "Medium", path: siMedium.path },
  podcast: { icon: "podcast", label: "Podcast" },
  reddit: { label: "Reddit", path: siReddit.path },
  slack: { icon: "slack", label: "Slack" },
  telegram: { label: "Telegram", path: siTelegram.path },
  threads: { label: "Threads", path: siThreads.path },
  website: { icon: "globe", label: "Website" },
  x: { label: "X", path: siX.path },
  youtube: { label: "YouTube", path: siYoutube.path },
};

/** A configured social link, with the icon it's shown by. */
export interface FooterSocialLink extends SocialIcon {
  href: string;
}

const isFooterSocial = (key: string): key is FooterSocial =>
  Object.hasOwn(SOCIAL_ICONS, key);

/** The site's repository, as the footer links it. */
export interface FooterRepoLink {
  href: string;
  /** Its accessible name, in the page's language ("GitHub repository"). */
  label: string;
}

/**
 * The footer's social links, in the order written, each with its icon. The
 * footer is the only place the site links its repository, so `repo` (from
 * `github` in the config) leads as the GitHub link, unless `socials.github`
 * names one itself.
 */
export const footerSocialLinks = (
  socials: Partial<Record<FooterSocial, string>>,
  repo?: FooterRepoLink | null
): FooterSocialLink[] => {
  const links = Object.entries(socials).flatMap(([platform, href]) =>
    isFooterSocial(platform) && href
      ? [{ ...SOCIAL_ICONS[platform], href }]
      : []
  );
  return repo && !socials.github
    ? [{ ...SOCIAL_ICONS.github, ...repo }, ...links]
    : links;
};
