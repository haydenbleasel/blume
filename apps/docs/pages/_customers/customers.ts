// Who builds their docs with Blume. `customers` is every team whose
// Blume-built site we link to — the homepage logo marquee and the /customers
// logo wall — and `stories` are the long-form write-ups, each with its own
// static route under customers/ (so it gets an OG card and a sitemap entry,
// like the compare pages). A story's panel, on the homepage carousel and the
// /customers index, comes straight from its entry here; its body lives in its
// route file.

export interface Customer {
  /** The customer's Blume-built docs site. */
  href: string;
  /**
   * A single-color wordmark in `public/logos/`, drawn as a CSS mask so it
   * takes any color; the width and height are its viewBox, which sets the
   * aspect ratio before the file loads.
   */
  logo: { height: number; src: string; width: number };
  name: string;
}

export const customers = {
  betterResult: {
    href: "https://better-result.dev/",
    logo: { height: 152, src: "/logos/better-result.svg", width: 925 },
    name: "Better Result",
  },
  chatjs: {
    href: "https://www.chatjs.dev/docs",
    logo: { height: 152, src: "/logos/chatjs.svg", width: 631 },
    name: "ChatJS",
  },
  filesSdk: {
    href: "https://files-sdk.dev/",
    logo: { height: 152, src: "/logos/files-sdk.svg", width: 768 },
    name: "Files SDK",
  },
  infrats: {
    href: "https://infra-ts.dev/",
    logo: { height: 152, src: "/logos/infrats.svg", width: 621 },
    name: "infrats",
  },
  neon: {
    href: "https://ui.neon.com/installation",
    logo: { height: 45, src: "/logos/neon.svg", width: 157 },
    name: "Neon",
  },
  orpc: {
    href: "https://orpc.dev/docs/",
    logo: { height: 152, src: "/logos/orpc.svg", width: 527 },
    name: "oRPC",
  },
  quiverai: {
    href: "https://docs.quiver.ai",
    logo: { height: 16, src: "/logos/quiverai.svg", width: 100 },
    name: "QuiverAI",
  },
  specific: {
    href: "https://docs.specific.dev/",
    logo: { height: 168, src: "/logos/specific.svg", width: 838 },
    name: "Specific",
  },
  stagewise: {
    href: "https://docs.stagewise.io/",
    logo: { height: 152, src: "/logos/stagewise.svg", width: 893 },
    name: "Stagewise",
  },
  // Composed from the official telemetry.dev mark plus its Geist SemiBold
  // wordmark, converted to outlines so it renders identically everywhere.
  telemetry: {
    href: "https://telemetry.dev/",
    logo: { height: 115, src: "/logos/telemetry.svg", width: 753 },
    name: "Telemetry",
  },
  ultracite: {
    href: "https://www.ultracite.ai/",
    logo: { height: 152, src: "/logos/ultracite.svg", width: 703 },
    name: "Ultracite",
  },
} satisfies Record<string, Customer>;

/** The logo marquee and logo wall, in display order. */
export const logoWall: Customer[] = [
  customers.neon,
  customers.orpc,
  customers.quiverai,
  customers.specific,
  customers.stagewise,
  customers.ultracite,
  customers.filesSdk,
  customers.betterResult,
  customers.infrats,
  customers.chatjs,
  customers.telemetry,
];

export interface CustomerStory {
  /**
   * The panel's fill: the customer's brand color, taken deep enough that
   * white type on it passes AA.
   */
  color: string;
  customer: Customer;
  /** What the story page's fact list shows beside the summary. */
  facts: {
    /** Blume features the site leans on, each linked to its docs page. */
    features: { href: string; label: string }[];
    industry: string;
    /** The tool the docs moved from, by its id in migrate-sources.ts. */
    migratedFrom?: string;
  };
  id: string;
  /**
   * The story's photo, in `public/customers/`: landscape, at least 1600px
   * wide. It fills the panel's right half (cropped to cover, so keep the
   * subject near the middle) and the story page's art beside the numbers.
   */
  image: { alt: string; src: string };
  meta: { description: string; title: string };
  /** Two headline numbers, value first. */
  stats: { label: string; value: string }[];
  /** The story page's lede, beneath the headline. */
  summary: string;
  /** The headline's muted follow-up. */
  tagline: string;
  /** The headline's lead, in white on the panel. */
  title: string;
}

// Specific's story and photo are from Iman Radjavi (2026-09-26). QuiverAI is
// a draft: its image is a capture of its docs standing in for a photo, its
// numbers are counted from its sitemap, and the bracketed copy (here and in
// customers/quiverai.astro) is placeholder until its content lands.
export const stories: CustomerStory[] = [
  {
    color: "oklch(0.5 0.17 38)",
    customer: customers.specific,
    facts: {
      features: [
        { href: "/docs/configuration/assistant", label: "Assistant" },
        { href: "/docs/discoverability/mcp", label: "MCP server" },
        { href: "/docs/deployment#server-rendering", label: "Node server" },
      ],
      industry: "Cloud platform for coding agents",
      migratedFrom: "mintlify",
    },
    id: "specific",
    image: {
      alt: "Two people from Specific presenting to a seated audience, the Specific dashboard projected beside them",
      src: "/customers/specific.webp",
    },
    meta: {
      description:
        "Specific migrated its docs from Mintlify to Blume in an afternoon and now hosts them on its own platform: Lighthouse performance went from 87 to 100, and hosting from $500 a month to a couple dollars.",
      title: "Specific migrated from Mintlify to Blume in an afternoon",
    },
    stats: [
      { label: "Lighthouse performance, up from 87", value: "100" },
      { label: "Saved every month on docs hosting", value: "$500" },
    ],
    summary:
      "Specific, the cloud platform for coding agents, runs everything it can on itself. With Blume, that now includes its docs.",
    tagline: "in an afternoon.",
    title: "Specific migrated from Mintlify",
  },
  {
    color: "oklch(0.45 0.09 225)",
    customer: customers.quiverai,
    facts: {
      features: [
        { href: "/docs/references/openapi", label: "API reference" },
        { href: "/docs/discoverability/markdown", label: "Markdown mirrors" },
      ],
      industry: "AI vector design",
    },
    id: "quiverai",
    image: {
      alt: "The QuiverAI docs, built with Blume",
      src: "/customers/quiverai.webp",
    },
    meta: {
      description: "How QuiverAI runs its docs on Blume.",
      title: "QuiverAI runs its docs on Blume",
    },
    stats: [
      { label: "Docs pages", value: "31" },
      { label: "API reference pages", value: "9" },
    ],
    summary:
      "[Summary: who QuiverAI is and the one-sentence version of how Blume fits in.]",
    tagline: "[The outcome, in one line.]",
    title: "QuiverAI runs its docs on Blume",
  },
];

/** A story by its id; throws at build time on a typo in a route file. */
export const storyById = (id: string): CustomerStory => {
  const story = stories.find((entry) => entry.id === id);
  if (!story) {
    throw new Error(`Unknown customer story: ${id}`);
  }
  return story;
};
