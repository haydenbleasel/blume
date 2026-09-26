// Prices for the /pricing page: what running Blume costs on your own host and
// model provider, beside Mintlify, the hosted platform the compare pages set
// Blume against. Every third-party number comes from that vendor's own page as
// of `checked` (listed in `sources`), so re-verify before editing. The
// calculator's math lives here too, and ships to the browser as source
// (`estimateSource`), so the rendered page and the sliders agree.

/** When the third-party prices were last verified. */
export const checked = "September 26, 2026";

export const prices = {
  /** Tokens one assistant answer spends: the grounding excerpts, one search, one page read, and the reply. */
  answer: { inputTokens: 14_000, outputTokens: 1000 },
  cloudflare: {
    freeRequestsPerDay: 100_000,
    paidBase: 5,
    paidIncludedRequests: 10_000_000,
    paidPerMillion: 0.3,
  },
  mintlify: {
    creditsIncluded: 10_000,
    creditsPerAnswer: 25,
    creditsPerNarration: 50,
    overagePerCredit: 0.01,
    packs: [
      { credits: 15_000, price: 145 },
      { credits: 40_000, price: 370 },
      { credits: 90_000, price: 800 },
    ],
    proAnnual: 450,
    proMonthly: 540,
    starterEditors: 5,
  },
  /** The assistant's model, at its Vercel AI Gateway list price in dollars per million tokens. */
  model: { id: "openai/gpt-6-luna", input: 0.1, output: 0.5 },
  /** Generated voices: a 1,000-word page is about 6,000 characters of prose. */
  narration: {
    charsPerPage: 6000,
    model: "openai/tts-1-hd",
    perMillionChars: 30,
  },
};

export type Prices = typeof prices;

export interface PricingInput {
  /** Assistant answers a month. */
  answers: number;
  editors: number;
  mcp: boolean;
  /** Pages whose narration is generated a month, new or changed. */
  narrated: number;
  /** Page views a month. */
  views: number;
}

export interface ReceiptLine {
  amount: string;
  label: string;
  note: string;
}

export interface Receipt {
  lines: ReceiptLine[];
  total: string;
  yearly: string;
}

export interface Estimate {
  blume: Receipt;
  /** One sentence on which bill is lower, and by how much a year. */
  difference: string;
  mintlify: Receipt;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

const count = (n: number): string => n.toLocaleString("en-US");

const money = (n: number): string => {
  const whole = Number.isInteger(n) || n >= 1000;
  return `$${n.toLocaleString("en-US", {
    maximumFractionDigits: whole ? 0 : 2,
    minimumFractionDigits: whole ? 0 : 2,
  })}`;
};

interface Bill {
  lines: ReceiptLine[];
  total: number;
}

const receipt = (bill: Bill): Receipt => ({
  lines: bill.lines,
  total: money(bill.total),
  yearly: money(cents(bill.total * 12)),
});

/**
 * Mintlify's bill. Starter covers five editors and no AI features; anything
 * more is Pro, billed annually. Credits beyond Pro's monthly allowance take the
 * cheapest cover: overage alone, or one add-on with overage on the rest.
 */
const mintlifyBill = (input: PricingInput, p: Prices): Bill => {
  const m = p.mintlify;
  const hosting = {
    amount: "Included",
    label: "Hosting and search",
    note: input.mcp ? "MCP server included" : "",
  };
  const credits =
    input.answers * m.creditsPerAnswer + input.narrated * m.creditsPerNarration;
  if (input.editors <= m.starterEditors && credits === 0) {
    const starter = {
      amount: "$0",
      label: "Starter plan",
      note: `Up to ${m.starterEditors} editors, no AI features`,
    };
    return { lines: [starter, hosting], total: 0 };
  }
  const extra = Math.max(0, credits - m.creditsIncluded);
  let cover = {
    cost: cents(extra * m.overagePerCredit),
    note: `${count(extra)} at $0.01 each`,
  };
  for (const pack of m.packs) {
    const rest = Math.max(0, extra - pack.credits);
    const cost = cents(pack.price + rest * m.overagePerCredit);
    if (cost < cover.cost) {
      const overage = rest > 0 ? ` + ${count(rest)} at $0.01` : "";
      cover = { cost, note: `${count(pack.credits)}-credit add-on${overage}` };
    }
  }
  const lines = [
    {
      amount: money(m.proAnnual),
      label: "Pro plan",
      note: `Unlimited editors, billed annually (${money(m.proMonthly)} month to month)`,
    },
  ];
  if (credits > 0) {
    const used = `${count(credits)} used, ${count(m.creditsIncluded)} included`;
    lines.push({
      amount: extra > 0 ? money(cover.cost) : "Included",
      label: "AI credits",
      note: extra > 0 ? `${used}; ${cover.note}` : used,
    });
  }
  lines.push(hosting);
  return { lines, total: cents(m.proAnnual + cover.cost) };
};

interface Hosting {
  amount: number;
  note: string;
}

/**
 * Cloudflare, where static files are free. The assistant or MCP server makes
 * it a server build, whose Worker answers page views too, so those count
 * against the free plan's daily requests.
 */
const cloudflareHosting = (input: PricingInput, p: Prices): Hosting => {
  const c = p.cloudflare;
  const requests = input.views + input.answers;
  if (!(input.mcp || input.answers > 0)) {
    return { amount: 0, note: "Static files, with unlimited requests" };
  }
  if (requests <= c.freeRequestsPerDay * 30) {
    return {
      amount: 0,
      note: "Workers free plan, up to 100,000 requests a day",
    };
  }
  const over = Math.max(0, requests - c.paidIncludedRequests);
  return {
    amount: cents(c.paidBase + (over / 1_000_000) * c.paidPerMillion),
    note: "Workers Paid: 10 million requests, then $0.30 a million",
  };
};

/** Blume's bill: the host, plus what the model provider charges for the assistant and generated narration. */
const blumeBill = (input: PricingInput, p: Prices): Bill => {
  const hosting = cloudflareHosting(input, p);
  const editors = `${count(input.editors)} ${input.editors === 1 ? "editor" : "editors"}`;
  const lines = [
    { amount: "$0", label: "Blume", note: `MIT license, ${editors} in Git` },
    {
      amount: money(hosting.amount),
      label: "Hosting on Cloudflare",
      note: hosting.note,
    },
  ];
  let total = hosting.amount;
  if (input.answers > 0) {
    const perThousand =
      (p.answer.inputTokens * p.model.input +
        p.answer.outputTokens * p.model.output) /
      1000;
    const cost = cents((input.answers * perThousand) / 1000);
    total += cost;
    lines.push({
      amount: money(cost),
      label: "Assistant",
      note: `${count(input.answers)} answers on ${p.model.id}, about ${money(cents(perThousand))} per 1,000`,
    });
  }
  if (input.narrated > 0) {
    const n = p.narration;
    const cost = cents(
      (input.narrated * n.charsPerPage * n.perMillionChars) / 1_000_000
    );
    total += cost;
    lines.push({
      amount: money(cost),
      label: "Narration",
      note: `${count(input.narrated)} pages on ${n.model}, or $0 with browser voices`,
    });
  }
  lines.push({
    amount: "$0",
    label: input.mcp ? "Search and MCP server" : "Search",
    note: "Built into your site",
  });
  return { lines, total: cents(total) };
};

/** Both monthly bills for one team, itemized, and the yearly difference. */
export const estimate = (input: PricingInput, p: Prices): Estimate => {
  const blume = blumeBill(input, p);
  const mintlify = mintlifyBill(input, p);
  const gap = money(cents(Math.abs(mintlify.total - blume.total) * 12));
  let difference = "The same price: at this size, both are free.";
  if (blume.total < mintlify.total) {
    difference = `Blume costs ${gap} less a year.`;
  } else if (blume.total > mintlify.total) {
    difference = `Mintlify costs ${gap} less a year.`;
  }
  return {
    blume: receipt(blume),
    difference,
    mintlify: receipt(mintlify),
  };
};

/**
 * `estimate` and every function it calls, as source for the calculator's
 * inline script, so the page and the browser run one implementation. Each is
 * inlined as `toString()` gives it, so keep their bodies free of comments and
 * of anything but their arguments, built-ins, and each other.
 */
export const estimateSource = Object.entries({
  blumeBill,
  cents,
  cloudflareHosting,
  count,
  estimate,
  mintlifyBill,
  money,
  receipt,
})
  .map(([name, fn]) => `const ${name}=${fn.toString()};`)
  .join("");

/** The inputs a slider sets: the numeric ones. */
export type FieldKey = "answers" | "editors" | "narrated" | "views";

export interface Field {
  key: FieldKey;
  label: string;
  steps: number[];
}

/** The calculator's sliders: each position is one step, so the scales can grow unevenly. */
export const fields: Field[] = [
  {
    key: "editors",
    label: "Editors",
    steps: [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100],
  },
  {
    key: "views",
    label: "Page views a month",
    steps: [
      5000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
      2_500_000, 5_000_000, 10_000_000,
    ],
  },
  {
    key: "answers",
    label: "Assistant answers a month",
    steps: [0, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000],
  },
  {
    key: "narrated",
    label: "Pages narrated a month",
    steps: [0, 10, 25, 50, 100, 250, 500],
  },
];

/** Starting points for the calculator; the middle one is what the page renders. */
export const presets: {
  id: string;
  input: PricingInput;
  label: string;
}[] = [
  {
    id: "open-source",
    input: {
      answers: 0,
      editors: 3,
      mcp: true,
      narrated: 0,
      views: 25_000,
    },
    label: "Open-source project",
  },
  {
    id: "startup",
    input: {
      answers: 1000,
      editors: 10,
      mcp: true,
      narrated: 25,
      views: 100_000,
    },
    label: "Startup",
  },
  {
    id: "growing",
    input: {
      answers: 10_000,
      editors: 30,
      mcp: true,
      narrated: 100,
      views: 1_000_000,
    },
    label: "Growing company",
  },
];

/** The pages each price was checked against. */
export const sources = [
  { href: "https://www.mintlify.com/pricing", label: "Mintlify pricing" },
  {
    href: "https://www.mintlify.com/docs/credits",
    label: "Mintlify AI credits",
  },
  {
    href: "https://developers.cloudflare.com/workers/platform/pricing/",
    label: "Cloudflare Workers",
  },
  { href: "https://vercel.com/pricing", label: "Vercel" },
  { href: "https://www.netlify.com/pricing/", label: "Netlify" },
  {
    href: "https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages",
    label: "GitHub Pages",
  },
  {
    href: "https://vercel.com/ai-gateway/models",
    label: "Vercel AI Gateway models",
  },
];

/**
 * Feature by feature: what each costs on Blume, then on Mintlify. Strings may
 * mark code spans with backticks (rendered by `inlineCode`).
 */
export const costs: { blume: string; label: string; them: string }[] = [
  {
    blume: "One plan with everything, free under the MIT license",
    label: "Plans",
    them: "Starter: free for 5 editors, no AI features. Pro: $450 a month billed annually, or $540 month to month. Enterprise: on request",
  },
  {
    blume: "Unlimited: anyone with access to your repo",
    label: "Editors",
    them: "5 on Starter; unlimited on Pro",
  },
  {
    blume:
      "$0 as static files on Cloudflare or GitHub Pages; otherwise your host's price",
    label: "Hosting and custom domain",
    them: "Included on every plan",
  },
  {
    blume:
      "$0: a local index built into the site, or a hosted provider by adapter",
    label: "Search",
    them: "Included",
  },
  {
    blume:
      "$0 on Cloudflare Workers' free plan, up to 100,000 requests a day; $5 a month for 10 million",
    label: "MCP server",
    them: "Included on every plan",
  },
  {
    blume:
      "Your provider's token price for the model you choose: about $1.90 per 1,000 answers on `openai/gpt-6-luna`",
    label: "AI assistant",
    them: "Pro and up: 25 credits an answer ($0.25 at overage), so 10,000 monthly credits cover 400 answers; questions it can't answer are free",
  },
  {
    blume:
      "$0 with browser voices; generated voices cost about $0.18 for a 1,000-word page on `openai/tts-1-hd`, and a rebuild pays only for changed sentences",
    label: "Narration",
    them: "50 credits ($0.50 at overage) each time it generates a page's audio",
  },
  {
    blume:
      "`blume validate` and `blume audit` run in CI for $0; `blume translate` and the update-docs skill run on your coding agent's plan",
    label: "Docs maintenance",
    them: "Automations: 250 credits ($2.50 at overage) for each run that changes your docs",
  },
  {
    blume:
      "Nothing to buy: your provider bills what you use, and rate limiting caps each reader",
    label: "More AI usage",
    them: "Add-ons of 15,000 credits for $145, 40,000 for $370, or 90,000 for $800 a month; overage at $0.01 a credit, off by default",
  },
  {
    blume:
      "Your host's access protection, such as Cloudflare Access or Vercel Deployment Protection",
    label: "Private docs",
    them: "Reader authentication on every plan; SSO, SCIM, and RBAC on Enterprise",
  },
  {
    blume: "Your own provider by adapter; Cloudflare Web Analytics is free",
    label: "Analytics",
    them: "A built-in dashboard",
  },
];

/**
 * Where a Blume site can run, and what each host charges for it. Each mark is
 * a simple-icons path (CC0) on a 24×24 viewBox, filled with the brand's color,
 * or the text color for the black marks so they hold up in dark mode.
 */
export const hosts: {
  free: string;
  logo: { color: string; path: string };
  name: string;
  paid: string;
}[] = [
  {
    free: "Unlimited requests to static files, and 100,000 Worker requests a day for the assistant and MCP server",
    logo: {
      color: "#F38020",
      path: "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
    },
    name: "Cloudflare",
    paid: "Workers Paid: $5 a month for 10 million requests, then $0.30 a million",
  },
  {
    free: "Hobby, for personal and non-commercial projects",
    logo: {
      color: "currentColor",
      path: "m12 1.608 12 20.784H0Z",
    },
    name: "Vercel",
    paid: "Pro: $20 a month per developer seat, with $20 of usage included",
  },
  {
    free: "300 credits a month; a production deploy uses 15, and a GB of bandwidth 20",
    logo: {
      color: "#00C7B7",
      path: "M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2L5.13 6.31Zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14Zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14ZM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65l-.14-.13Zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65l-.14-.14Z",
    },
    name: "Netlify",
    paid: "Personal: $9 a month for 1,000 credits. Pro: $20 a month for 3,000",
  },
  {
    free: "Public repositories, static builds only, with a soft limit of 100 GB of bandwidth a month",
    logo: {
      color: "currentColor",
      path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    },
    name: "GitHub Pages",
    paid: "Private repositories, on GitHub Pro, Team, or Enterprise",
  },
];

/** Questions answered at the foot of the page, also emitted as FAQPage JSON-LD. */
export const faq: { answer: string; question: string }[] = [
  {
    answer:
      "Yes. Blume is open source under the MIT license, with no paid tier, seats, or usage limits, and no account to sign up for. You pay only for your host and, if you turn on AI features, your model provider.",
    question: "Is Blume really free?",
  },
  {
    answer:
      "No. `blume build` outputs a site you deploy to your own host: Cloudflare, Vercel, Netlify, GitHub Pages, any static host, or a Node server. Nothing phones home.",
    question: "Is there a hosted version of Blume?",
  },
  {
    answer:
      "Not for most docs. A static build covers pages, search, llms.txt, Markdown mirrors, and Open Graph images. The assistant and the MCP server need a server build, which you get by naming your host's adapter in `blume.config.ts`.",
    question: "Do I need a server?",
  },
  {
    answer:
      "Your model provider's token price. Each answer sends the most relevant pages of your docs to the model, which comes to about $1.90 per 1,000 answers on `openai/gpt-6-luna`. A larger model costs more per answer, and you choose which one. Rate limiting is on by default, at 30 questions per reader every 10 minutes, so a script can't run up the bill.",
    question: "What does the assistant cost to run?",
  },
  {
    answer:
      "A browser editor, a hosted analytics dashboard, and a vendor to call. With Blume, pages live in your Git repo, analytics go to the provider you choose, and support is GitHub issues. Someone on your team owns the deploy and upgrades the `blume` package.",
    question: "What do I give up by not paying for a platform?",
  },
  {
    answer:
      "[Sponsor the project on GitHub](https://github.com/sponsors/haydenbleasel), report issues, or send a pull request. Blume stays free either way.",
    question: "How can I support Blume?",
  },
];

/** Where sponsorships go: the maintainer's GitHub Sponsors page. */
export const sponsorUrl = "https://github.com/sponsors/haydenbleasel";

/**
 * The GitHub Sponsors tiers, as that page lists them as of `checked`, so
 * re-verify there before editing. Every tier but the first is monthly.
 */
export const sponsorTiers: { perk: string; price: string }[] = [
  { perk: "Choose your own amount, monthly or one-time", price: "Any amount" },
  { perk: "A Sponsor badge on your GitHub profile", price: "$5" },
  { perk: "Your logo or name in the project's README", price: "$25" },
  { perk: "Your logo or name on the project's website", price: "$100" },
  { perk: "Your logo or name on every project website", price: "$250" },
  { perk: "Help and support in your company's chat", price: "$1,000" },
];
