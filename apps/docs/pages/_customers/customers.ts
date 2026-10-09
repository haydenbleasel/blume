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
  neon: {
    href: "https://ui.neon.com/installation",
    logo: { height: 45, src: "/logos/neon.svg", width: 157 },
    name: "Neon",
  },
  ordinal: {
    href: "https://docs.tryordinal.com/",
    logo: { height: 31, src: "/logos/ordinal.svg", width: 113 },
    name: "Ordinal",
  },
  orpc: {
    href: "https://orpc.dev/",
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
    href: "https://telemetry.dev/docs",
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
  customers.ordinal,
  customers.stagewise,
  customers.ultracite,
  customers.filesSdk,
  customers.betterResult,
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

// Specific's story and photo are from Iman Radjavi (2026-09-26); Ordinal's
// story is from Francisco's migration notes (2026-10-07); QuiverAI's story and
// photos are from Nicklas Scharpff (2026-10-08); Telemetry's story and photos
// are from Ephraim Atta-Duncan (2026-10-08); ChatJS's story and photos are
// from Francisco Moretti (2026-10-08); oRPC's story is from its own write-up
// (2026-10-08).
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
    color: "oklch(0.42 0.06 179)",
    customer: customers.ordinal,
    facts: {
      features: [
        { href: "/docs/references/openapi", label: "OpenAPI reference" },
        { href: "/docs/cli/validate", label: "blume validate" },
        { href: "/docs/configuration/assistant", label: "Assistant" },
        { href: "/docs/discoverability/mcp", label: "MCP server" },
      ],
      industry: "Social media for B2B teams",
      migratedFrom: "mintlify",
    },
    id: "ordinal",
    image: {
      alt: "Francisco, right, and a colleague smiling over lunch at a sidewalk café table",
      src: "/customers/ordinal.webp",
    },
    meta: {
      description:
        "Ordinal moved its docs from Mintlify to Blume in one evening, kept every guide URL, and replaced Mintlify's docs agent with a scheduled Claude Code routine.",
      title: "Ordinal migrated from Mintlify to Blume in one evening",
    },
    stats: [
      { label: "Hands-on time; Claude Code did the rest", value: "20 min" },
      { label: "Saved every year at Mintlify's renewal", value: "$3,000" },
    ],
    summary:
      "Ordinal, the social media platform for B2B teams, was paying for a docs editor nobody used. Blume moved its docs in an evening, and a Claude Code routine now keeps them current.",
    tagline: "while walking the dog.",
    title: "Ordinal moved from Mintlify",
  },
  {
    color: "oklch(0.48 0.1 230)",
    customer: customers.quiverai,
    facts: {
      features: [
        {
          href: "/docs/configuration/customization#component-overrides",
          label: "Component overrides",
        },
        { href: "/docs/configuration/theming", label: "Theming" },
        { href: "/docs/references/openapi", label: "OpenAPI reference" },
        { href: "/docs/discoverability/llms-txt", label: "llms.txt" },
      ],
      industry: "AI models for graphic design",
      migratedFrom: "mintlify",
    },
    id: "quiverai",
    image: {
      alt: "Nicklas Scharpff and Joan Rodriguez of QuiverAI, smiling against a white wall",
      src: "/customers/quiverai.webp",
    },
    meta: {
      description:
        "QuiverAI, the frontier AI lab behind the Arrow SVG models, helped shape Blume from the start, moved its docs from Mintlify in less than a day, and now runs its internal design system docs on Blume too.",
      title:
        "QuiverAI helped shape Blume, then moved its docs in less than a day",
    },
    stats: [
      { label: "From Mintlify to production", value: "< 1 day" },
      { label: "Docs sites on Blume, public and internal", value: "2" },
    ],
    summary:
      "QuiverAI, the frontier AI lab for graphic design, wanted the freedom of a custom docs site without building one. It helped shape Blume from the start, then moved its docs over in less than a day.",
    tagline: "from the start.",
    title: "QuiverAI helped shape Blume",
  },
  {
    color: "oklch(0.27 0.006 286)",
    customer: customers.telemetry,
    facts: {
      features: [
        {
          href: "/docs/configuration/customization#component-overrides",
          label: "Component overrides",
        },
        {
          href: "/docs/discoverability/markdown#custom-component-serializers",
          label: "Markdown for agents",
        },
        { href: "/docs/discoverability/llms-txt", label: "llms.txt" },
        { href: "/docs/deployment#subpath-deploys", label: "Subpath deploys" },
      ],
      industry: "Observability for AI applications",
    },
    id: "telemetry",
    image: {
      alt: "Ephraim Atta-Duncan of Telemetry speaking at a lectern, a slide titled AI SDK & Google Gemini on the screen behind",
      src: "/customers/telemetry.webp",
    },
    meta: {
      description:
        "Telemetry, the open-source observability platform for AI applications and agents, started its docs on Blume: static files it hosts itself at telemetry.dev/docs, with a Markdown copy of every page for coding agents.",
      title: "Telemetry chose Blume for its first docs",
    },
    stats: [
      { label: "Pages, each with a Markdown copy for agents", value: "38" },
      { label: "Integration guides, up from 11 at launch", value: "20" },
    ],
    summary:
      "Telemetry, the observability platform for AI applications and agents, needed docs from scratch. It wanted to choose where they ran and make them easy for coding agents to work with, so it started on Blume.",
    tagline: "for its first docs.",
    title: "Telemetry chose Blume",
  },
  {
    color: "oklch(0.3 0.012 70)",
    customer: customers.chatjs,
    facts: {
      features: [
        { href: "/docs/deployment#subpath-deploys", label: "Subpath deploys" },
        { href: "/docs/cli/validate", label: "blume validate" },
        { href: "/docs/cli/evals", label: "Evals" },
        {
          href: "/docs/discoverability/agent-discovery#skills-discovery",
          label: "Agent skills",
        },
      ],
      industry: "Foundation for AI apps",
      migratedFrom: "mintlify",
    },
    id: "chatjs",
    image: {
      alt: "Francisco Moretti, creator of ChatJS, smiling in a sunlit room with a concrete wall and a brick-framed window behind him",
      src: "/customers/chatjs.webp",
    },
    meta: {
      description:
        "ChatJS, the open-source foundation for AI apps, moved 71 pages of docs from Mintlify to Blume in a single AI chat, kept every chatjs.dev/docs URL, and fixed what it needed in Blume itself.",
      title: "ChatJS moved its docs from Mintlify to Blume in a single AI chat",
    },
    stats: [
      { label: "Pages moved in a single AI chat", value: "71" },
      { label: "Hours spent on docs deployment since the move", value: "0" },
    ],
    summary:
      "ChatJS, the open-source foundation for AI apps, wanted polished docs without building a docs platform, and room to change them later. Blume gave it both, and the move took a single AI chat.",
    tagline: "in a single AI chat.",
    title: "ChatJS moved from Mintlify",
  },
  {
    color: "oklch(0.5 0.17 359)",
    customer: customers.orpc,
    facts: {
      features: [
        { href: "/docs/content/syntax#display-types", label: "Twoslash" },
        { href: "/docs/content/syntax#diagrams", label: "Mermaid diagrams" },
        { href: "/docs/discoverability/mcp", label: "MCP server" },
        { href: "/docs/discoverability/llms-txt", label: "llms.txt" },
      ],
      industry: "Typesafe API framework",
      migratedFrom: "vitepress",
    },
    id: "orpc",
    image: {
      alt: "A laptop glowing on a dark wooden desk at night, a code editor on its screen with pink highlights and a type hint open over one line, a mug and a notebook beside it",
      src: "/customers/orpc.webp",
    },
    meta: {
      description:
        "oRPC, the open-source framework for typesafe APIs, moved 96 pages from VitePress to Blume in less than a day, kept every URL and Twoslash example inside its monorepo, and replaced 16 dev dependencies with one.",
      title: "oRPC moved 96 pages from VitePress to Blume in less than a day",
    },
    stats: [
      { label: "Lighthouse performance on mobile, up from 48", value: "76" },
      { label: "URLs changed in the move", value: "0" },
    ],
    summary:
      "oRPC, the open-source framework for typesafe APIs, wanted Mintlify-level docs without moving them out of its monorepo. Blume moved all 96 pages over in less than a day, Twoslash examples and all.",
    tagline: "inside its own repo.",
    title: "oRPC got Mintlify-level docs",
  },
];

/**
 * A headline split around its hyphenated words ("Mintlify-level"), each
 * flagged `whole` so the story panel, page, and OG card keep it on one line:
 * in a narrow panel, browsers and the card's renderer otherwise break after
 * the hyphen.
 */
export const headlineParts = (
  text: string
): { text: string; whole: boolean }[] =>
  text
    .split(/(?<hyphenated>\S+-\S+)/u)
    .map((part, index) => ({ text: part, whole: index % 2 === 1 }))
    .filter((part) => part.text !== "");

/** A story by its id; throws at build time on a typo in a route file. */
export const storyById = (id: string): CustomerStory => {
  const story = stories.find((entry) => entry.id === id);
  if (!story) {
    throw new Error(`Unknown customer story: ${id}`);
  }
  return story;
};
