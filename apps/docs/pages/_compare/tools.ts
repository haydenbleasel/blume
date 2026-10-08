// Per-tool content for the /compare/<tool> pages. Every claim about the other
// tool comes from its own site as of `checked` (its docs, and pricing if any), so
// re-verify before editing, and keep rows where both tools match: a fair table
// is the credible one. Blume's side comes from these docs. Strings may mark
// code spans with backticks (rendered by `inlineCode`).
import type { MigrateSource } from "../_home/migrate-sources.ts";
import { sourceById } from "../_home/migrate-sources.ts";

export interface CompareTool {
  /** When the claims about the other tool were last verified. */
  checked: string;
  /** Questions answered at the foot of the page, also emitted as FAQPage JSON-LD. */
  faq: { answer: string; question: string }[];
  /** Where the other tool is the better choice — said plainly. */
  fit: { body: string; title: string }[];
  /** The at-a-glance rows: what, then Blume's answer and theirs. */
  glance: { blume: string; label: string; them: string }[];
  /** What the migration carries over, and the concrete rewrites it makes. */
  carryOver: {
    items: { body: string; title: string }[];
    mappings: { from: string; to: string }[];
    tagline: string;
  };
  id: string;
  /**
   * The camp the tool sits in on /compare: a platform that hosts your docs,
   * or a framework you run yourself. Groups the directory and the "Three ways
   * to ship docs" columns.
   */
  kind: "framework" | "hosted";
  meta: { description: string; title: string };
  /** Independent agent-readiness scans of each project's own docs site. */
  scores?: { blume: number; href: string; name: string; them: number }[];
  source: MigrateSource;
  /** The pages on the other tool's own site the claims were checked against. */
  sources: { href: string; label: string }[];
  summary: string;
  tagline: string;
}

const mintlify: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Callouts become `:::` directives, Cards, Steps, Columns, Frame, and Tooltip carry over as they are, and Tabs gain an `inline` prop.",
        title: "Pages stay MDX.",
      },
      {
        body: "`docs.json` groups become folders and tabs stay tabs, with a redirect for every URL that moves.",
        title: "Navigation moves into folders.",
      },
      {
        body: "Blume generates the reference from the same spec, with a Try it playground on every operation.",
        title: "Your OpenAPI spec keeps working.",
      },
      {
        body: "A bundled codemod remaps Font Awesome icons to Lucide and renames frontmatter keys like `sidebarTitle`.",
        title: "Icons and frontmatter, handled.",
      },
    ],
    mappings: [
      { from: "docs.json", to: "blume.config.ts" },
      { from: "<Note>", to: ":::note" },
      { from: "<AccordionGroup>", to: "<Accordion>" },
      { from: "<Tabs>", to: "<Tabs inline>" },
      { from: "<ParamField>", to: "<TypeTable>" },
      { from: "<RequestExample>", to: "<CodeGroup>" },
      { from: "sidebarTitle", to: "sidebar.label" },
    ],
    tagline: "Your MDX stays MDX, and an agent does the move.",
  },
  checked: "September 23, 2026",
  faq: [
    {
      answer:
        "Yes. Blume is open source under the MIT license, with no seats, plans, or usage credits, and you host it wherever you like.",
      question: "Is Blume free?",
    },
    {
      answer:
        "Yes. Pages stay MDX. `npx blume migrate mintlify --codex` converts callouts to directives, maps Mintlify's components to Blume's, and turns docs.json navigation into folders and tabs.",
      question: "Can I keep my Mintlify MDX?",
    },
    {
      answer:
        "Yes. The assistant answers readers in the page using the model and provider you choose, and an opt-in MCP server lets coding agents search and read your docs. Both run on a server deployment.",
      question: "Does Blume have an AI assistant and an MCP server?",
    },
    {
      answer:
        "Anywhere: Vercel, Netlify, Cloudflare, a Node server, or any static host. `blume build` outputs static files by default.",
      question: "Where can I host Blume?",
    },
    {
      answer:
        "The agent reports anything without a Blume equivalent, such as footer social links, per-language banners, and dynamic redirects, so you can decide what to do with each.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Mintlify's browser editor lets teammates publish without touching Git. Blume is Markdown and MDX in your repo.",
      title: "You want a web editor.",
    },
    {
      body: "Mintlify hosts the site, the assistant, and the analytics dashboard. With Blume you deploy to your own host and bring your own model provider and analytics.",
      title: "You'd rather not run anything.",
    },
    {
      body: "Mintlify supports reader authentication for private docs, and SSO, SCIM, and RBAC on Enterprise.",
      title: "You need private docs or enterprise controls.",
    },
  ],
  glance: [
    {
      blume: "Free and open source, with no seat limits",
      label: "Price",
      them: "Free Starter for 5 editors without AI features; Pro from $450 a month",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "Mintlify's cloud; self-hosting on AWS or Kubernetes on Enterprise",
    },
    {
      blume: "Markdown and MDX in your repo, in any editor",
      label: "Editing",
      them: "A web editor, plus MDX synced from Git",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "An assistant on Pro, metered in credits at 25 per answer",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI and AsyncAPI with an API playground, plus GraphQL reference pages",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Multi-language docs with a language switcher",
    },
    {
      blume: "`blume eject` hands you a standalone Astro app",
      label: "Leaving",
      them: "Your MDX lives in Git; the site renders on Mintlify's platform",
    },
  ],
  id: "mintlify",
  kind: "hosted",
  meta: {
    description:
      "Compare Blume and Mintlify on pricing, hosting, AI and agent features, and API references, and see how an agent migrates your Mintlify docs to Blume.",
    title: "Blume vs Mintlify: the open-source Mintlify alternative",
  },
  scores: [
    {
      blume: 100,
      href: "https://is-agentic.com/scan/useblume.dev",
      name: "is-agentic.com",
      them: 78,
    },
    {
      blume: 80,
      href: "https://isitagentready.com/useblume.dev",
      name: "isitagentready.com",
      them: 40,
    },
  ],
  source: sourceById("mintlify"),
  sources: [
    { href: "https://www.mintlify.com/pricing", label: "Pricing" },
    {
      href: "https://www.mintlify.com/docs/deploy/self-host",
      label: "Self-hosting",
    },
    { href: "https://www.mintlify.com/docs/editor", label: "Editor" },
    { href: "https://www.mintlify.com/docs/credits", label: "AI credits" },
    {
      href: "https://www.mintlify.com/docs/api-playground/overview",
      label: "API playground",
    },
    {
      href: "https://www.mintlify.com/docs/guides/internationalization",
      label: "Internationalization",
    },
  ],
  summary:
    "The polished docs, API references, and AI features you'd reach for Mintlify for, as a free, open-source framework you host anywhere. Your MDX comes with you, and an agent does the move.",
  tagline: "The open-source Mintlify alternative.",
};

const fumadocs: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Frontmatter, Steps, TypeTable, `<include>`, and heading anchors like `[#id]` use the same syntax, and Callouts become `:::` directives.",
        title: "Pages stay MDX.",
      },
      {
        body: "Page order, titles, icons, and collapsed state carry over, and `root` folders become header tabs.",
        title: "Every meta.json becomes meta.ts.",
      },
      {
        body: "Blume builds OpenAPI and GraphQL pages from the same spec or schema, so the generated stubs and their scripts go away.",
        title: "References rebuild from your specs.",
      },
      {
        body: "Once the agent has read what it needs, the host framework, `source.config.ts`, and `mdx-components.tsx` are removed.",
        title: "The app comes out.",
      },
    ],
    mappings: [
      { from: "meta.json", to: "meta.ts" },
      { from: '"root": true', to: "navigation.tabs" },
      { from: '<Callout type="warn">', to: ":::warning" },
      { from: "<Cards>", to: "<CardGroup>" },
      { from: "<Accordions>", to: "<Accordion>" },
      { from: "<Files>", to: "<Tree>" },
      { from: '"BookOpen"', to: '"book-open"' },
    ],
    tagline: "Your MDX stays MDX, and an agent does the move.",
  },
  checked: "September 23, 2026",
  faq: [
    {
      answer:
        "Fumadocs is a framework you scaffold into your own app and then own, down to the route handlers. Blume is the whole site from a folder of Markdown, with no app code, and search, API references, llms.txt, Markdown mirrors, and an MCP server built in. When you want the code, `blume eject` hands you a standalone Astro app.",
      question: "What's the difference between Blume and Fumadocs?",
    },
    {
      answer:
        "Yes. Pages stay MDX, and Fumadocs syntax like `<include>`, `[#id]` heading anchors, and TypeTable works in Blume as it is. The agent converts Callouts to directives and every `meta.json` into a typed `meta.ts`.",
      question: "Can I keep my Fumadocs MDX?",
    },
    {
      answer:
        "Yes. `blume version` freezes a snapshot with a switcher, an old-version banner, and version-scoped search, and the MCP server is a config switch on a server deployment, with no route code to maintain.",
      question: "Does Blume do versioning and MCP like Fumadocs?",
    },
    {
      answer:
        "No. Blume renders static HTML with Astro and ships no React by default. You can still write interactive islands in React, Vue, or Svelte.",
      question: "Is Blume built on React?",
    },
    {
      answer:
        "Folder descriptions, reversed or extracted page ordering in `meta.json`, and components like `<DynamicCodeBlock>` and `<InlineTOC>`. The agent reports each one so you can decide what to do with it, and approximates a `full` page with `mode: wide`.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Fumadocs runs inside Next.js, React Router, TanStack Start, Waku, or Astro with React, so your docs share the app's routing, auth, and components.",
      title: "Your docs live inside a React app.",
    },
    {
      body: "Fumadocs copies its UI into your repo, keeps its core headless, and lets you configure the remark and rehype pipeline directly.",
      title: "You want to own every line.",
    },
    {
      body: "Fumadocs renders on the server, so pages can fetch content at request time or filter by who's reading.",
      title: "Your content is dynamic.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "An app you scaffold: `source.config.ts`, layouts, and route handlers",
    },
    {
      blume: "Astro, generated and run for you",
      label: "Built on",
      them: "Next.js, React Router, TanStack Start, Waku, or Astro with React",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT)",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt and Markdown routes in the templates; an MCP route added by its CLI",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI, AsyncAPI, and GraphQL packages, with a playground",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "A folder per version with a dropdown, or a branch per version",
    },
    {
      blume:
        "`blume audit`, `validate`, and `eval` check SEO, links, and agent answers in CI",
      label: "Quality checks",
      them: "Link validation you add to your app",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Locale routing, UI translations, and localized search",
    },
  ],
  id: "fumadocs",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Fumadocs on setup, agent features, API references, and versioning, and see how an agent migrates your Fumadocs site to Blume.",
    title: "Blume vs Fumadocs: a zero-config Fumadocs alternative",
  },
  scores: [
    {
      blume: 100,
      href: "https://is-agentic.com/scan/useblume.dev",
      name: "is-agentic.com",
      them: 63,
    },
    {
      blume: 80,
      href: "https://isitagentready.com/useblume.dev",
      name: "isitagentready.com",
      them: 20,
    },
  ],
  source: sourceById("fumadocs"),
  sources: [
    { href: "https://fumadocs.dev/docs", label: "Frameworks" },
    {
      href: "https://fumadocs.dev/docs/integrations/llms",
      label: "llms.txt and MCP",
    },
    {
      href: "https://fumadocs.dev/docs/integrations/openapi",
      label: "OpenAPI",
    },
    { href: "https://fumadocs.dev/docs/navigation", label: "Versioning" },
    {
      href: "https://fumadocs.dev/docs/internationalization",
      label: "Internationalization",
    },
  ],
  summary:
    "Fumadocs gives you a React app to own. Blume turns a folder of Markdown into the whole site, with search, API references, versioning, llms.txt, and an MCP server built in rather than scaffolded into your code.",
  tagline: "Your docs as content, not an app.",
};

const docusaurus: CompareTool = {
  carryOver: {
    items: [
      {
        body: "`:::note`, `:::tip`, and the rest are directives in both (in `.mdx` pages on Blume), and Tabs and TabItem become Tabs and Tab.",
        title: "Admonitions already fit.",
      },
      {
        body: "Autogenerated sidebars become Blume's filesystem navigation, and each `_category_.json` becomes a typed `meta.ts`.",
        title: "Sidebars move into folders.",
      },
      {
        body: "The agent migrates your latest version, turns blog posts into Blume blog pages with their RSS feed at `/blog/rss.xml`, and moves translations into locale folders.",
        title: "Your latest version, posts, and locales come along.",
      },
      {
        body: "OpenAPI and GraphQL doc plugins, static client redirects, and Mermaid become built-in Blume config.",
        title: "Plugins become config.",
      },
    ],
    mappings: [
      { from: "docusaurus.config.ts", to: "blume.config.ts" },
      { from: "_category_.json", to: "meta.ts" },
      { from: '<TabItem label="…">', to: '<Tab title="…">' },
      { from: "sidebar_position", to: "sidebar.order" },
      { from: "static/", to: "public/" },
      { from: ":::tip Title", to: ":::tip[Title]" },
      { from: "```bash npm2yarn", to: "```package-install" },
    ],
    tagline: "Your admonitions already fit, and an agent does the rest.",
  },
  checked: "September 23, 2026",
  faq: [
    {
      answer:
        "Because Blume has nothing to maintain. There's no React app or swizzled theme to upgrade, and API references, local search, llms.txt, Markdown mirrors, and an MCP server are built in rather than community plugins.",
      question: "Why switch from Docusaurus if both are free?",
    },
    {
      answer:
        "Yes. `blume version` freezes a snapshot of the current docs, and Blume adds the version switcher, an old-version banner, version-scoped search, and canonical links to the latest. The agent migrates your latest Docusaurus version by default.",
      question: "Can Blume version my docs like Docusaurus?",
    },
    {
      answer:
        "Yes. Docusaurus admonitions are already directive syntax, so `:::note` and `:::tip` carry over. Blume reads directives in MDX only, so the agent renames every `.md` page that uses one to `.mdx`, converts Tabs, and moves `static/` into `public/`.",
      question: "Do my admonitions and MDX carry over?",
    },
    {
      answer:
        "Posts become Blume blog pages with an RSS feed at the same `/blog/rss.xml`. The agent moves dates from filenames into frontmatter and adds redirects for the old dated URLs. Blume doesn't generate the blog's index, tag, author, or archive pages, so you build the index page yourself.",
      question: "What happens to my blog?",
    },
    {
      answer:
        "Swizzled theme components, React pages under `src/pages`, footer columns, the blog's generated index, tag, author, and archive pages, and a few frontmatter keys. The agent reports each one so you can rebuild it with a layout slot or a custom page, or leave it out.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Docusaurus has years of production use, around a million weekly npm downloads, and a plugin for nearly everything.",
      title: "You want the largest ecosystem.",
    },
    {
      body: "Docusaurus documents a Crowdin workflow and extracts UI strings for translators. Blume translates with your coding agent instead.",
      title: "You translate through Crowdin.",
    },
    {
      body: "Docusaurus gives you React pages, swizzling for any theme component, and a plugin lifecycle API. Blume keeps the app hidden until you eject.",
      title: "You want to own a React app.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "A React site: `docusaurus.config`, `sidebars.js`, and any swizzled components",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT), maintained by Meta",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Algolia DocSearch first-class; local search through community plugins",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "Community plugins for llms.txt and Markdown routes; no official MCP server",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "Ask AI through Algolia DocSearch, off by default",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI and GraphQL through community plugins",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Built-in versioning with `docs:version`",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Built-in i18n with Git or Crowdin workflows",
    },
  ],
  id: "docusaurus",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Docusaurus on setup, search, agent features, API references, and versioning, and see how an agent migrates your Docusaurus site to Blume.",
    title: "Blume vs Docusaurus: the zero-config Docusaurus alternative",
  },
  source: sourceById("docusaurus"),
  sources: [
    { href: "https://docusaurus.io/docs/search", label: "Search" },
    { href: "https://docusaurus.io/docs/versioning", label: "Versioning" },
    { href: "https://docusaurus.io/docs/i18n/introduction", label: "i18n" },
    {
      href: "https://docusaurus.io/community/resources",
      label: "Community plugins",
    },
    {
      href: "https://github.com/facebook/docusaurus/issues/10899",
      label: "llms.txt issue",
    },
  ],
  summary:
    "Versioning, i18n, blog posts with RSS, and search like Docusaurus, plus API references, llms.txt, Markdown mirrors, and an MCP server built in. All from a folder of Markdown, with no React app to maintain.",
  tagline: "The zero-config Docusaurus alternative.",
};

const starlight: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Blume reads `src/content/docs` in place. Pages with asides become `.mdx`, since Blume renders directives in MDX.",
        title: "Content stays where it is.",
      },
      {
        body: "`:::note`, `:::tip`, `:::caution`, and `:::danger` carry over, titles and all.",
        title: "Asides keep their names.",
      },
      {
        body: "starlight-openapi and starlight-versions become Blume config, starlight-blog posts become blog pages with RSS, and link validation and image zoom are already built in.",
        title: "Plugins map to built-ins.",
      },
      {
        body: "Starlight component overrides map nearly one to one to Blume's layout slots, so a custom header or footer comes along.",
        title: "Overrides map to layout slots.",
      },
    ],
    mappings: [
      { from: "starlight({ … })", to: "blume.config.ts" },
      { from: "<CardGrid>", to: "<CardGroup>" },
      { from: "<LinkCard>", to: "<Card>" },
      { from: '<TabItem label="…">', to: '<Tab title="…">' },
      { from: "pagefind: false", to: "search.exclude: true" },
      { from: "lastUpdated: true", to: 'lastModified: "git"' },
      { from: "customCss", to: "theme.css" },
    ],
    tagline: "Astro to Astro, and an agent does the move.",
  },
  checked: "September 23, 2026",
  faq: [
    {
      answer:
        "Starlight is an integration you add to an Astro project you own and configure. Blume generates and runs the Astro project for you from a folder of Markdown, and builds in what Starlight leaves to plugins: llms.txt, an MCP server, API references, versioning, and blog posts with RSS.",
      question: "Blume and Starlight both use Astro. What's the difference?",
    },
    {
      answer:
        "Yes. Replace any MDX component or layout slot with your own, write islands in React, Vue, or Svelte, or run `blume eject` for a standalone Astro app.",
      question: "Can I still customize components?",
    },
    {
      answer:
        "Only pages that use asides or other directives. Blume renders `:::` directives in `.mdx` files, so the agent renames those pages, and plain Markdown can stay `.md`.",
      question: "Do I have to rename my .md files?",
    },
    {
      answer:
        "Anywhere: Vercel, Netlify, Cloudflare, a Node server, or any static host. `blume build` outputs static files by default.",
      question: "Where can I host Blume?",
    },
    {
      answer:
        "Designed splash and hero pages (the agent gives a splash page `mode: center` and turns its hero into plain content), `head` entries other than meta tags and analytics scripts, social links on platforms the footer doesn't cover, starlight-blog's generated index, tag, and author pages, and plugins without a Blume equivalent. The agent reports each one.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Starlight adds docs as routes inside your own Astro project, sharing its config, pages, and adapter. Blume generates a separate project for your docs.",
      title: "You already have an Astro site.",
    },
    {
      body: "Starlight is maintained by the Astro team, tracks Astro releases closely, and runs production docs like Cloudflare's and Netlify's.",
      title: "You want the Astro team's theme.",
    },
    {
      body: "Starlight supports Markdoc through an official package. Blume supports Markdown and MDX.",
      title: "You write in Markdoc.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "An Astro project: `astro.config`, a content collection, and your overrides",
    },
    {
      blume: "Astro, generated and run for you",
      label: "Built on",
      them: "Astro, as an integration in your project",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Pagefind built in; Algolia DocSearch through an official plugin",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "Community plugins for llms.txt, Markdown pages, and copy buttons",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI through the community starlight-openapi plugin",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Through the community starlight-versions plugin",
    },
    {
      blume: "Blog and changelog page types, with RSS",
      label: "Blog and changelog",
      them: "Community plugins, such as starlight-blog",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Built-in i18n with fallback content and right-to-left support",
    },
  ],
  id: "starlight",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Starlight, two Astro docs frameworks, on setup, agent features, API references, and versioning, and see how an agent migrates your site.",
    title: "Blume vs Starlight: Astro docs with nothing to set up",
  },
  source: sourceById("starlight"),
  sources: [
    { href: "https://starlight.astro.build/manual-setup/", label: "Setup" },
    {
      href: "https://starlight.astro.build/guides/site-search/",
      label: "Search",
    },
    { href: "https://starlight.astro.build/guides/i18n/", label: "i18n" },
    {
      href: "https://starlight.astro.build/resources/plugins/",
      label: "Plugins",
    },
  ],
  summary:
    "Both build on Astro. Starlight is a theme for an Astro project you own; Blume generates and runs the project for you, with llms.txt, an MCP server, API references, and versioning built in rather than added as plugins.",
  tagline: "Astro docs, with nothing to set up.",
};

const nextra: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Page order, folder titles, and hidden pages carry over, and root `page` entries become header tabs.",
        title: "Every _meta file becomes meta.ts.",
      },
      {
        body: "Nextra infers titles from `_meta` and each page's first heading. The agent writes them into frontmatter, so no page is renamed.",
        title: "Titles land in frontmatter.",
      },
      {
        body: "Callouts and GitHub alerts become directives, and Tabs, Cards, Steps, and FileTree map to Blume's.",
        title: "Components map across.",
      },
      {
        body: "Nextra 4 `page.mdx` files move into a plain content folder, and static redirects in `next.config` carry over.",
        title: "App Router pages restructure.",
      },
    ],
    mappings: [
      { from: "_meta.ts", to: "meta.ts" },
      { from: "> [!NOTE]", to: ":::note" },
      { from: '<Callout type="error">', to: ":::danger" },
      { from: "<Tabs items={…}>", to: '<Tab title="…">' },
      { from: "<Cards.Card>", to: "<Card>" },
      { from: "<FileTree.Folder>", to: "<Tree.Folder>" },
      { from: "sidebarTitle", to: "sidebar.label" },
    ],
    tagline: "Your MDX stays MDX, and an agent does the move.",
  },
  checked: "September 23, 2026",
  faq: [
    {
      answer:
        "Nextra's latest npm release is 4.6.1, from December 2025, and llms.txt, API references, and versioning aren't built in. Blume ships all three, plus Markdown mirrors and an MCP server, with no Next.js app to maintain.",
      question: "Why move from Nextra?",
    },
    {
      answer:
        "Yes. The agent turns every `_meta` file into a typed `meta.ts`, keeping page order, folder titles, and hidden pages, and writes page titles into frontmatter.",
      question: "Can I keep my _meta navigation?",
    },
    {
      answer:
        "Yes. Readers can copy any page as Markdown or open it in ChatGPT, Claude, and other assistants, and every page has a `.md` mirror that agents can fetch directly.",
      question: "Does Blume have a copy-page button?",
    },
    {
      answer:
        "Anywhere: Vercel, Netlify, Cloudflare, a Node server, or any static host. `blume build` outputs static files by default, with no Next.js runtime to host.",
      question: "Where can I host Blume?",
    },
    {
      answer:
        "Footer content, most per-page `theme` switches (`layout: 'full'` becomes `mode: wide`, the closest layout), `_meta` separators and menus, and the `<Bleed>` component. The agent reports each one so you can decide what to do with it.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Nextra wraps your next.config, so docs share your app's layout, auth, middleware, and React Server Components.",
      title: "Your docs live inside a Next.js app.",
    },
    {
      body: "Nextra is a Next.js app you control end to end, from routing to rendering, with custom React themes when the built-in ones don't fit.",
      title: "You want to own the React app.",
    },
    {
      body: "Nextra ships a blog theme with a post index, tags, and RSS. Blume gives posts RSS and structured data, but you build the index page yourself.",
      title: "You want a ready-made blog theme.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "A Next.js app: `next.config`, `_meta` files, and `mdx-components`",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT)",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Pagefind, set up with a postbuild script",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "A copy-page button with Open in ChatGPT and Claude; no llms.txt or MCP server",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "A guide to adding Inkeep, a hosted service",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "Not built in; a TSDoc component renders TypeScript types",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Not built in",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Next.js i18n with locale folders, in the docs theme",
    },
  ],
  id: "nextra",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Nextra on setup, search, agent features, API references, and versioning, and see how an agent migrates your Nextra site to Blume.",
    title: "Blume vs Nextra: a Nextra alternative with no Next.js app",
  },
  source: sourceById("nextra"),
  sources: [
    { href: "https://nextra.site/docs/guide/search", label: "Search" },
    { href: "https://nextra.site/docs/guide/search/ai", label: "Ask AI" },
    { href: "https://nextra.site/docs/guide/i18n", label: "i18n" },
    {
      href: "https://github.com/shuding/nextra/issues/4784",
      label: "llms.txt issue",
    },
    { href: "https://www.npmjs.com/package/nextra", label: "npm releases" },
  ],
  summary:
    "Everything Nextra gives you, plus llms.txt, Markdown mirrors, an MCP server, API references, and versioning, from a folder of Markdown with no Next.js app to maintain.",
  tagline: "Nextra docs, with no Next.js app.",
};

const gitbook: CompareTool = {
  carryOver: {
    items: [
      {
        body: "The agent works out each URL from `SUMMARY.md`, checks it against your sitemap, and moves each file there, so the route and the sidebar both match.",
        title: "Every page keeps its URL.",
      },
      {
        body: "Hints become `:::` directives, and tabs, steppers, content refs, and `<details>` become Tabs, Steps, Cards, and expandable sections.",
        title: "Blocks become components.",
      },
      {
        body: "Files in `.gitbook/includes` become `<include>` partials, and `.gitbook/vars.yaml` becomes Blume's `variables`.",
        title: "Reusable content becomes includes.",
      },
      {
        body: "Redirects from `.gitbook.yaml` and your site settings move into `blume.config.ts`, and a bundled script pins GitBook's heading anchors.",
        title: "Old links still land.",
      },
    ],
    mappings: [
      { from: "SUMMARY.md", to: "folders and meta.ts" },
      { from: '{% hint style="info" %}', to: ":::info" },
      { from: "{% stepper %}", to: "<Steps>" },
      { from: "{% content-ref %}", to: "<Card>" },
      { from: "<details>", to: "<Expandable>" },
      { from: ".gitbook/includes/", to: "_includes/" },
      { from: "README.md", to: "index.mdx" },
    ],
    tagline: "Your synced Markdown comes along, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "GitBook is a hosted platform built around a web editor, priced per site and per user, with AI answers metered in credits. Blume is a free, open-source framework that builds the whole site from Markdown in your repo, and you host it anywhere.",
      question: "What's the difference between Blume and GitBook?",
    },
    {
      answer:
        "Yes, once your spaces sync to GitHub or GitLab. `npx blume migrate gitbook --codex` moves every page to the URL `SUMMARY.md` gave it, converts hints, tabs, steppers, and content refs, and turns reusable content into includes.",
      question: "Can I keep my GitBook content?",
    },
    {
      answer:
        "Yes. Pages keep their GitBook URLs, `.gitbook.yaml` redirects carry over, and a bundled script pins GitBook's heading anchors so deep links still land. Site redirects come along too when you export them with a GitBook API token.",
      question: "Will my old links keep working?",
    },
    {
      answer:
        "Yes. The assistant answers readers in the page using the model and provider you choose, billed by that provider rather than in credits, and an opt-in MCP server lets coding agents search and read your docs. Both run on a server deployment.",
      question: "Does Blume have an AI assistant and an MCP server?",
    },
    {
      answer:
        "Site themes beyond your accent color, fonts, and mode, page covers, adaptive content and visitor authentication, embeds other than YouTube as players, and spaces or translations that aren't in the repository. The agent reports each one, and GitBook Assistant has no counterpart unless you set up Blume's assistant.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "GitBook's block editor, with change requests and real-time collaboration, lets writers and product managers publish without Git, while Git Sync keeps a repository in step.",
      title: "You want a web editor.",
    },
    {
      body: "On Ultimate, GitBook signs readers in through Auth0, Okta, Azure AD, or OIDC, and adaptive content shows or hides content for each reader. Blume relies on your host's protection, which covers the whole site.",
      title: "You need private or tailored docs.",
    },
    {
      body: "GitBook hosts the site, search, assistant, and analytics. With Blume you deploy to your own host and bring your own model provider and analytics.",
      title: "You'd rather not run anything.",
    },
  ],
  glance: [
    {
      blume: "Free and open source, with no seat limits",
      label: "Price",
      them: "Free for one user; Essential from $65 a month per site, plus $12 a user",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "GitBook's cloud; only its open-source renderer can be self-hosted",
    },
    {
      blume: "Markdown and MDX in your repo, in any editor",
      label: "Editing",
      them: "A block-based web editor, with two-way Git Sync to GitHub or GitLab",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "Answers in search on Essential, chat on Ultimate, metered at 20 credits each",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt, `.md` pages, and an MCP server for every site, on every plan",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI blocks with a Test it playground powered by Scalar",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Language variants, with AI translation at 30 credits per 1,000 words",
    },
    {
      blume: "`blume eject` hands you a standalone Astro app",
      label: "Leaving",
      them: "Git Sync writes GitBook-flavored Markdown; site settings stay in the app",
    },
  ],
  id: "gitbook",
  kind: "hosted",
  meta: {
    description:
      "Compare Blume and GitBook on pricing, hosting, editing, AI and agent features, and API references, and see how an agent migrates your GitBook docs to Blume.",
    title: "Blume vs GitBook: the open-source GitBook alternative",
  },
  source: sourceById("gitbook"),
  sources: [
    { href: "https://www.gitbook.com/pricing", label: "Pricing" },
    {
      href: "https://gitbook.com/docs/account-and-billing/plans/ai-credits",
      label: "AI credits",
    },
    { href: "https://github.com/GitbookIO/gitbook", label: "Self-hosting" },
    {
      href: "https://gitbook.com/docs/docs-as-code/git-sync",
      label: "Git Sync",
    },
    {
      href: "https://gitbook.com/docs/getting-started/llm-ready-docs",
      label: "LLM-ready docs",
    },
    {
      href: "https://gitbook.com/docs/create-content/openapi",
      label: "OpenAPI",
    },
  ],
  summary:
    "GitBook is a hosted editor priced per site and per user, with AI answers metered in credits. Blume builds the whole site from Markdown in your repo, with no seats, credits, or plan limits, and an agent moves your GitBook pages without changing a URL.",
  tagline: "Open-source docs, with no seats or credits.",
};

const readme: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Section folders keep their `/docs/` and `/reference/` paths, categories become group folders, and nested pages pin their old URL with `slug`.",
        title: "Every URL stays flat.",
      },
      {
        body: "Each OpenAPI file becomes an `openapi()` source, endpoint prose moves into an overlay, and every old endpoint URL redirects to its operation page.",
        title: "The reference rebuilds from your specs.",
      },
      {
        body: "Emoji callouts, code tabs, `[block:…]` JSON, glossary terms, and ReadMe's components become directives, CodeGroup, Tooltip, and Blume components.",
        title: "A codemod converts the syntax.",
      },
      {
        body: "There's no config file in Git, so the agent reads your logo, colors, fonts, and navigation from the settings every hub page embeds.",
        title: "Settings come from your hub.",
      },
    ],
    mappings: [
      { from: "_order.yaml", to: "meta.ts" },
      { from: "docs/Getting Started/", to: "docs/(Getting Started)/" },
      { from: "> 📘 Title", to: ":::info[Title]" },
      { from: "doc:quickstart", to: "/docs/quickstart" },
      { from: "<Cards columns>", to: "<CardGroup cols>" },
      { from: "<Glossary>", to: "<Tooltip>" },
      { from: "excerpt", to: "description" },
    ],
    tagline: "Your URLs stay flat, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "ReadMe is a hosted developer hub with a web editor, API metrics, and logins for personalized docs, from $250 a month on Pro. Blume is a free, open-source framework that builds your guides, changelog, and API reference from files in your repo, and you host it anywhere.",
      question: "What's the difference between Blume and ReadMe?",
    },
    {
      answer:
        "Yes. `npx blume migrate readme --codex` runs a bundled codemod that keeps every page at its flat ReadMe URL, converts callouts, code tabs, and ReadMe's components, and redirects every old API reference URL.",
      question: "Can I keep my ReadMe pages and URLs?",
    },
    {
      answer:
        "Blume generates it from the OpenAPI files you already sync, with the prose from your endpoint pages, in ReadMe's order. Try it sends requests from the reader's browser, so your API must allow your docs origin, or you turn on Blume's proxy on a server deployment.",
      question: "What happens to my API reference?",
    },
    {
      answer:
        "Connect bi-directional sync to a new, empty repository under Settings → Git Connection, and ReadMe writes the whole hub there, with every version as a branch. Then run the migration from that repository.",
      question: "What if my hub isn't in Git?",
    },
    {
      answer:
        "ReadMe's hosted features (the editor, branches and reviews, API metrics and request logs, discussions, and the landing page builder), personalized docs with per-reader API keys, login-gated docs, and recipe walkthroughs. The agent reports each one, and Blume's Try it takes the credentials readers type.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "ReadMe's editor, with branches, reviews, and multiplayer editing on Pro, lets teammates publish without touching Git. Blume is Markdown and MDX in your repo.",
      title: "You want a web editor.",
    },
    {
      body: "With a JWT login, ReadMe shows each developer their own API keys in code samples and Try It, and their recent requests once you send it your API logs.",
      title: "You want docs that know the reader.",
    },
    {
      body: "ReadMe adds discussion forums, recipes, a landing page builder, and API usage metrics to the docs. Blume covers the docs, changelog, and API reference, and leaves community and metrics to other tools.",
      title: "You want a whole developer hub.",
    },
  ],
  glance: [
    {
      blume: "Free and open source, with no seat limits",
      label: "Price",
      them: "Free Starter with one admin; Pro from $250 a month with five admins",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "ReadMe's cloud, on `*.readme.io` or your own domain",
    },
    {
      blume: "Markdown and MDX in your repo, in any editor",
      label: "Editing",
      them: "A web editor, plus two-way sync with GitHub, GitLab, or Bitbucket",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "Ask AI Lite on Pro; full Ask AI is a $150-a-month add-on",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt, Markdown for agents, and an MCP server; its doc search is an add-on",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI, Swagger, and Postman with Try It; GraphQL in limited support",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Versions with a dropdown; one on Starter, unlimited on Pro",
    },
    {
      blume: "`blume eject` hands you a standalone Astro app",
      label: "Leaving",
      them: "Pages sync to Git; settings, landing page, and metrics stay in ReadMe",
    },
  ],
  id: "readme",
  kind: "hosted",
  meta: {
    description:
      "Compare Blume and ReadMe on pricing, hosting, API references, and AI and agent features, and see how an agent migrates your ReadMe hub to Blume.",
    title: "Blume vs ReadMe: an open-source ReadMe alternative",
  },
  source: sourceById("readme"),
  sources: [
    { href: "https://readme.com/pricing", label: "Pricing" },
    {
      href: "https://docs.readme.com/main/docs/plans-and-pricing",
      label: "Plans",
    },
    { href: "https://docs.readme.com/main/docs/ask-ai", label: "Ask AI" },
    {
      href: "https://docs.readme.com/main/docs/ai-ready-docs",
      label: "AI-ready docs",
    },
    {
      href: "https://docs.readme.com/main/docs/bi-directional-sync",
      label: "Git sync",
    },
    { href: "https://docs.readme.com/main/docs/openapi", label: "OpenAPI" },
  ],
  summary:
    "ReadMe is a hosted developer hub with a web editor, API metrics, and personalized docs. Blume builds your guides, changelog, and API reference from files in your repo, free to host anywhere, and an agent moves your hub without breaking a URL.",
  tagline: "API docs that live in your repo.",
};

const mkdocs: CompareTool = {
  carryOver: {
    items: [
      {
        body: "A bundled codemod turns `!!!` admonitions into `:::` directives, `???` blocks into Expandable, and content tabs into Tabs or a CodeGroup.",
        title: "Admonitions and tabs convert.",
      },
      {
        body: "The `nav` list becomes folders and `meta.ts` files, with group folders and `slug` pins where the old nesting kept URLs.",
        title: "The nav moves into folders.",
      },
      {
        body: "Search, redirects, social cards, image zoom, the blog, git dates, and llmstxt become Blume config or are already built in.",
        title: "Plugins map to built-ins.",
      },
      {
        body: "The agent pins MkDocs' heading ids where Blume's differ, and turns every `redirect_maps` entry into a redirect.",
        title: "Old links keep working.",
      },
    ],
    mappings: [
      { from: "mkdocs.yml", to: "blume.config.ts" },
      { from: '!!! note "Title"', to: ":::note[Title]" },
      { from: '??? tip "Title"', to: '<Expandable title="…">' },
      { from: '=== "Tab"', to: '<Tab title="Tab">' },
      { from: '--8<-- "file.md"', to: "<include>" },
      { from: "{ #id }", to: "[#id]" },
      { from: "hide: [toc]", to: "mode: wide" },
    ],
    tagline: "A codemod converts the syntax, and an agent does the rest.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Material for MkDocs has been in maintenance mode since November 2025, fixing critical bugs but adding no features, and MkDocs' last stable release, 1.6.1, is from August 2024. Material's team also says the MkDocs 2.0 rewrite won't run Material. Blume builds in what MkDocs adds through plugins, like llms.txt, versioning, and API references, with no Python environment to maintain.",
      question: "Why move off MkDocs Material?",
    },
    {
      answer:
        "Yes. `npx blume migrate mkdocs --codex` opens an agent that runs a codemod over your pages, converting admonitions, content tabs, snippets, and heading ids and renaming only the pages that need MDX to `.mdx`. It then rebuilds `nav` as folders without changing a URL.",
      question: "Can I keep my Markdown?",
    },
    {
      answer:
        "If you want to keep your setup, Zensical is the smaller move: the Material for MkDocs team built it to read `mkdocs.yml` and build existing projects, though it hasn't reached 1.0 yet. Blume is the move if you want MDX components, OpenAPI, AsyncAPI, and GraphQL references with a Try it playground, and an MCP server, without a Python toolchain.",
      question: "Should I move to Zensical instead?",
    },
    {
      answer:
        "Blume doesn't generate references from Python docstrings, so the agent reports each mkdocstrings block. Keep that reference published where it is and link to it, or, for an HTTP API, let Blume build the reference from your OpenAPI spec.",
      question: "What happens to my mkdocstrings reference?",
    },
    {
      answer:
        "Output from mkdocstrings, mkdocs-click, and notebooks, macro functions and Jinja logic, template overrides and hooks with no layout slot, code annotations, tag index pages, and the blog's archive and category pages. The agent reports each one so you can decide what to do with it.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "mkdocstrings renders reference pages from Python source, with handlers for C, TypeScript, shell, and more. Blume has no docstring generator.",
      title: "Your API reference comes from docstrings.",
    },
    {
      body: "Zensical, from the Material for MkDocs team, reads `mkdocs.yml` and builds existing projects, with replacements for popular plugins. If maintenance mode is your only concern, it's the smaller move.",
      title: "You'd rather keep your setup.",
    },
    {
      body: "Material renders code annotations and generates tag pages and blog archive and category pages. Blume has none of these, so the agent reports each one.",
      title: "You lean on Material's extras.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "`mkdocs.yml`, a Python environment, the Material theme, and plugins",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source: MkDocs (BSD-2-Clause) and Material (MIT)",
    },
    {
      blume: "MDX components like Tabs, Steps, Cards, and CodeGroup",
      label: "Components",
      them: "Python-Markdown extensions: admonitions, content tabs, grids, and annotations",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Built-in client-side search with lunr, which also works offline",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt and Markdown copies through the third-party mkdocs-llmstxt plugin",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "Python and more through mkdocstrings; OpenAPI through community plugins",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "mike, an external tool that deploys each version through Git",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Theme UI in 60+ languages; one build per language, or the static-i18n plugin",
    },
  ],
  id: "mkdocs",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and MkDocs Material on maintenance, search, agent features, API references, and versioning, and see how an agent migrates your MkDocs docs.",
    title: "Blume vs MkDocs: a Material for MkDocs alternative",
  },
  source: sourceById("mkdocs"),
  sources: [
    {
      href: "https://squidfunk.github.io/mkdocs-material/blog/2025/11/05/zensical/",
      label: "Maintenance mode",
    },
    {
      href: "https://squidfunk.github.io/mkdocs-material/setup/setting-up-site-search/",
      label: "Search",
    },
    {
      href: "https://pawamoy.github.io/mkdocs-llmstxt/",
      label: "llms.txt plugin",
    },
    { href: "https://mkdocstrings.github.io/", label: "mkdocstrings" },
    {
      href: "https://squidfunk.github.io/mkdocs-material/setup/setting-up-versioning/",
      label: "Versioning",
    },
    {
      href: "https://squidfunk.github.io/mkdocs-material/setup/changing-the-language/",
      label: "Languages",
    },
  ],
  summary:
    "Material for MkDocs is in maintenance mode, and MkDocs' last stable release is from August 2024. Blume builds in MDX components, API references, versioning, llms.txt, and an MCP server, with no Python environment or plugins to maintain, and an agent does the move.",
  tagline: "MkDocs docs, with no Python to maintain.",
};

const vitepress: CompareTool = {
  carryOver: {
    items: [
      {
        body: "`::: tip` and `::: warning Title` become `:::tip` and `:::warning[Title]`, GitHub alerts become callouts, and code groups become CodeGroup.",
        title: "Containers become directives.",
      },
      {
        body: "Each sidebar becomes a header tab, and groups that existed only in config become `(group)` folders, so no page URL changes.",
        title: "Sidebars move into folders.",
      },
      {
        body: "`<<<` snippet imports become `<include>` with their titles and highlighted lines, and so do `<!--@include:-->` partials.",
        title: "Snippets become includes.",
      },
      {
        body: "Every old `.html` URL redirects to its page, and a script pins each heading's VitePress anchor so deep links still land.",
        title: "Old URLs and anchors keep working.",
      },
    ],
    mappings: [
      { from: ".vitepress/config.ts", to: "blume.config.ts" },
      { from: "themeConfig.sidebar", to: "meta.ts" },
      { from: "::: tip Title", to: ":::tip[Title]" },
      { from: "::: code-group", to: "<CodeGroup>" },
      { from: "::: details", to: "<Expandable>" },
      { from: "<<< @/snippets/a.ts", to: "<include>" },
      { from: "/guide/setup.html", to: "/guide/setup" },
    ],
    tagline: "A codemod does the Markdown, and an agent does the rest.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Because VitePress leaves the docs features to you. You list every sidebar page in config, llms.txt and API references come from community plugins, and versioning isn't built in. Blume builds navigation from your folders and ships all of those built in.",
      question: "Why switch from VitePress if both are free?",
    },
    {
      answer:
        "Yes. `npx blume migrate vitepress --codex` runs a codemod that converts containers, code groups, alerts, snippet imports, and badges, and renames pages that need MDX to `.mdx`. The agent then handles what's left, like Vue syntax and components, and redirects every old `.html` URL.",
      question: "Can I keep my VitePress Markdown?",
    },
    {
      answer:
        "Yes, as islands. Put the `.vue` file in `islands/`, install `@astrojs/vue` and `vue`, and use it in any `.mdx` page. A component that imports from `vitepress`, like `useData()`, doesn't run outside it, so the agent reports it for you to rewrite or drop.",
      question: "Can I keep my Vue components?",
    },
    {
      answer:
        "Not yet. The latest stable release is 1.6.4, from August 2025, and 2.0 has been in alpha since January 2025, with alpha.20 in September 2026. VitePress's own docs now install it with `vitepress@next`.",
      question: "Is VitePress 2 stable?",
    },
    {
      answer:
        "The Vue app around your Markdown: custom theme code, layout slots, data loaders, and dynamic routes become static content, Blume components, or islands. Vite and custom markdown-it plugins, `titleTemplate`, the footer message, and your DocSearch index don't carry over, and the agent reports each one.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Every VitePress page compiles to a Vue component, so `{{ }}` expressions, directives, and `<script setup>` work right in the Markdown. Blume pages are MDX, with Vue components as islands.",
      title: "You want Vue in every page.",
    },
    {
      body: "VitePress is maintained by the Vue team and runs the docs for Vue, Vite, Vitest, Rollup, and Pinia. Edits show in under 100ms in dev, and pages navigate instantly after the first load.",
      title: "You want what Vue and Vite use.",
    },
    {
      body: "A VitePress theme is a Vue layout you can extend or replace, and data loaders and dynamic routes generate pages at build time. Blume keeps the app hidden until you eject.",
      title: "You want to write the theme in Vue.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "`.vitepress/config` with a sidebar you list by hand, plus any theme code",
    },
    {
      blume: "Astro, generated and run for you",
      label: "Built on",
      them: "Vite and Vue 3, with every page compiled as a Vue component",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT), maintained by the Vue team",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Local MiniSearch built in, or Algolia DocSearch",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt and Markdown pages through the community vitepress-plugin-llms; no official MCP server",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "Not built in; OpenAPI through the community vitepress-openapi plugin",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Not built in; an open feature request since 2020",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Built-in i18n with locale folders and a language switcher",
    },
  ],
  id: "vitepress",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and VitePress on setup, search, agent features, API references, and versioning, and see how an agent migrates your VitePress docs to Blume.",
    title: "Blume vs VitePress: the zero-config VitePress alternative",
  },
  source: sourceById("vitepress"),
  sources: [
    {
      href: "https://vitepress.dev/guide/what-is-vitepress",
      label: "What is VitePress",
    },
    {
      href: "https://vitepress.dev/reference/default-theme-search",
      label: "Search",
    },
    { href: "https://vitepress.dev/guide/using-vue", label: "Vue in Markdown" },
    { href: "https://vitepress.dev/guide/i18n", label: "i18n" },
    {
      href: "https://github.com/vuejs/vitepress/issues/109",
      label: "Versioning issue",
    },
    {
      href: "https://github.com/vuejs/vitepress/releases",
      label: "Releases",
    },
  ],
  summary:
    "VitePress is the Vue team's fast static generator, with a sidebar you list in config and agent features left to community plugins. Blume builds the site from your folders, with llms.txt, an MCP server, API references, and versioning built in.",
  tagline: "Docs from your folders, not your config.",
};

const fern: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Callouts become `:::` directives, and code groups, cards, accordions, and `<Markdown>` snippets map to Blume's components and includes.",
        title: "Pages stay MDX.",
      },
      {
        body: "`docs.yml` tabs and sections become folders and `meta.ts` files placed so each page keeps its URL, with a redirect for every endpoint and changelog date that moves.",
        title: "Navigation moves into folders.",
      },
      {
        body: "The agent exports the definition with the Fern CLI and restores its webhooks with an overlay, so every endpoint and webhook gets a page.",
        title: "Fern Definitions become OpenAPI.",
      },
      {
        body: "`fern.config.json`, `generators.yml`, and your API definition stay in `fern/`, so `fern generate` and `fern check` keep working.",
        title: "SDK generation stays put.",
      },
    ],
    mappings: [
      { from: "docs.yml", to: "blume.config.ts" },
      { from: "<Note>", to: ":::note" },
      { from: "<CodeBlocks>", to: "<CodeGroup>" },
      { from: "<Cards>", to: "<CardGroup>" },
      { from: "<Markdown src>", to: "<include>" },
      { from: "subtitle", to: "description" },
      { from: "sidebar-title", to: "sidebar.label" },
    ],
    tagline: "Your MDX stays MDX, and your SDKs stay with Fern.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Fern's Free plan hosts one site on Fern's cloud, with 1,000 pages, 250 AI credits a month, and Fern branding; custom CSS, JavaScript, and React need Enterprise. Blume has no plans or limits, runs on any host, and lets you replace any component or layout slot, or eject to a standalone Astro app.",
      question: "Why switch if Fern Docs has a free plan?",
    },
    {
      answer:
        "Yes. Pages stay MDX. `npx blume migrate fern --codex` converts callouts to directives, maps Fern's components to Blume's, and rebuilds `docs.yml` navigation as folders that keep every page URL.",
      question: "Can I keep my Fern MDX?",
    },
    {
      answer:
        "No. Only the docs move. The agent leaves `fern.config.json`, `generators.yml`, and your API definition in `fern/`, so `fern generate` and `fern check` keep working.",
      question: "Do I have to stop using Fern for SDKs?",
    },
    {
      answer:
        "Not directly. The agent exports it to OpenAPI with `fern export`, restores the webhooks and idempotency headers the export drops with an overlay, and writes a redirect for every endpoint URL that changes.",
      question: "Can Blume render a Fern Definition?",
    },
    {
      answer:
        "Fern's hosted features: Ask Fern, AI-generated examples, the dashboard and analytics, reader logins and RBAC, and the API Explorer's proxy and OAuth flow. In the reference, SDK snippets need rebuilding as `x-codeSamples`, and WebSocket, gRPC, and OpenRPC pages have no Blume equivalent. The agent reports each one.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Fern generates SDKs in up to ten languages from the same definition and shows calls from them on every endpoint. Blume renders the docs and shows SDK samples you add as `x-codeSamples`.",
      title: "You want docs and SDKs from one platform.",
    },
    {
      body: "Fern Editor lets teammates without Git access edit pages visually, and every change opens a pull request. Blume is Markdown and MDX in your repo.",
      title: "You want a web editor.",
    },
    {
      body: "Fern offers password protection on every plan, and SSO, JWT, RBAC, and API keys filled into the API Explorer for signed-in readers on Enterprise. Blume relies on your host's protection.",
      title: "You need gated docs.",
    },
  ],
  glance: [
    {
      blume: "Free and open source, with no seat limits",
      label: "Price",
      them: "Free for 10 members and 1,000 pages; Enterprise is custom-priced",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "Fern's cloud; self-hosting with a Docker image on Enterprise",
    },
    {
      blume: "Markdown and MDX in your repo, in any editor",
      label: "Editing",
      them: "A visual web editor that opens pull requests, plus MDX in Git",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "Ask Fern, at 2 AI credits a message; 250 credits a month on Free",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt and Markdown pages built in; an MCP server that spends AI credits",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI, AsyncAPI, GraphQL, gRPC, and OpenRPC, with an API Explorer",
    },
    {
      blume: "Not built in; shows your SDK calls from `x-codeSamples`",
      label: "SDKs",
      them: "Python and TypeScript free up to 200 endpoints; ten languages on Enterprise",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Localization on Enterprise, still in early access",
    },
  ],
  id: "fern",
  kind: "hosted",
  meta: {
    description:
      "Compare Blume and Fern on pricing, hosting, AI credits, and API references, and see how an agent migrates your Fern docs to Blume while SDKs stay put.",
    title: "Blume vs Fern: keep Fern's SDKs, own your docs",
  },
  source: sourceById("fern"),
  sources: [
    { href: "https://buildwithfern.com/pricing", label: "Pricing" },
    {
      href: "https://buildwithfern.com/learn/docs/self-hosted/overview",
      label: "Self-hosting",
    },
    {
      href: "https://buildwithfern.com/learn/docs/writing-content/fern-editor",
      label: "Editor",
    },
    {
      href: "https://buildwithfern.com/learn/docs/ai-features/overview",
      label: "AI credits",
    },
    {
      href: "https://buildwithfern.com/learn/docs/ai-features/mcp-server",
      label: "MCP server",
    },
    {
      href: "https://buildwithfern.com/learn/docs/localization/overview",
      label: "Localization",
    },
  ],
  summary:
    "Fern pairs hosted docs with SDK generation. Blume replaces the docs half with the same MDX, API references from your spec, llms.txt, and an MCP server, free and on any host, while `fern/` keeps generating your SDKs.",
  tagline: "Keep Fern's SDKs, own your docs.",
};

const redocly: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Admonitions become `:::` directives, tabs, cards, and accordions become Blume components, and partials become includes.",
        title: "Markdoc becomes MDX.",
      },
      {
        body: "`sidebars.yaml` groups become folders with a `meta.ts`, and a sidebar per section becomes a header tab.",
        title: "Sidebars move into folders.",
      },
      {
        body: "Each OpenAPI description renders with a page per operation, and a generated redirect covers every old operation URL.",
        title: "Every API gets a native reference.",
      },
      {
        body: "A trimmed `redocly.yaml` keeps its `apis`, `extends`, and `rules`, so `redocly lint` and `redocly bundle` run as before.",
        title: "Your lint setup stays.",
      },
    ],
    mappings: [
      { from: "redocly.yaml", to: "blume.config.ts" },
      { from: "sidebars.yaml", to: "meta.ts" },
      { from: "{% admonition %}", to: ":::info" },
      { from: "{% tabs %}", to: "<Tabs>" },
      { from: "{% partial %}", to: "<include>" },
      { from: "# H1", to: "title" },
      { from: "excludeFromSearch", to: "search.exclude" },
    ],
    tagline: "Markdoc becomes MDX, and your linter stays put.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Redocly hosts your docs and bills per contributor seat, with a page allowance on each plan, and AI search and an MCP server on Enterprise. Blume is free and open source, runs on any host, and has an opt-in AI assistant and MCP server on a server deployment. Redocly CLI keeps working on your specs.",
      question: "What's the difference between Blume and Redocly?",
    },
    {
      answer:
        "They become Markdown and MDX. `npx blume migrate redocly --codex` converts Markdoc tags to directives and components, moves each page's H1 into its frontmatter `title`, and rebuilds `sidebars.yaml` as folders and tabs. Pages that need no component stay `.md`.",
      question: "What happens to my Markdoc pages?",
    },
    {
      answer:
        "Yes. The agent trims `redocly.yaml` to its lint and bundle settings and leaves `@redocly/cli` and its CI jobs alone. Decorators don't run when Blume renders a spec, so the agent points the reference at `redocly bundle` output or an overlay instead.",
      question: "Does `redocly lint` keep working?",
    },
    {
      answer:
        "Yes. Version folders at the root become Blume versions, with a switcher and version-scoped search, and `@l10n` folders become locale folders. After the move, `blume translate` fills in every locale with your coding agent.",
      question: "Can Blume version and translate my docs like Realm?",
    },
    {
      answer:
        "Login, RBAC, and SSO; Reunite's editor, reviews, and feedback dashboard; the API explorer's mock server, environments, and saved auth; `x-tagGroups` names; per-reader content and Markdoc conditionals; and PlantUML and Excalidraw diagrams. The agent reports each one so you can decide what to do with it.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Reef adds an API catalog and scorecards that grade every API against several rulesets, and Reunite can keep an API that fails the baseline out of production. Blume renders specs; it doesn't grade them.",
      title: "You govern many APIs.",
    },
    {
      body: "Reunite lets teammates edit, preview, and review changes in the browser, with every edit committed to Git. Blume is Markdown and MDX in your repo.",
      title: "You want a web editor with visual reviews.",
    },
    {
      body: "Redocly's Enterprise plan adds SSO and guest SSO for readers, with RBAC that also governs AI search and the MCP server. Blume has no reader accounts; private docs use your host's protection.",
      title: "You need reader logins and RBAC.",
    },
  ],
  glance: [
    {
      blume: "Free and open source, with no seat limits",
      label: "Price",
      them: "From $10 a seat a month, with 100 pages; Markdown guides cost extra",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "Redocly's cloud, with single-tenant hosting on Enterprise+",
    },
    {
      blume: "Markdown and MDX in your repo, in any editor",
      label: "Editing",
      them: "Markdoc in Git, edited locally or in Reunite's web editor",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "On Enterprise, up to 3,500 questions a month per organization",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt and Markdown pages by default; a Docs MCP server on Enterprise",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "OpenAPI, AsyncAPI, GraphQL, and SOAP, with Try it and mock servers",
    },
    {
      blume:
        "Build warnings for specs that would render wrong; no ruleset linting",
      label: "API linting",
      them: "Open-source `redocly lint` with configurable rules, plus scorecards in Reef",
    },
    {
      blume: "`blume eject` hands you a standalone Astro app",
      label: "Leaving",
      them: "Markdoc in Git; the site renders on Redocly's platform",
    },
  ],
  id: "redocly",
  kind: "hosted",
  meta: {
    description:
      "Compare Blume and Redocly on pricing, hosting, AI and agent features, and API references, and see how an agent migrates your Redocly docs to Blume.",
    title: "Blume vs Redocly: keep the linter, own your docs",
  },
  source: sourceById("redocly"),
  sources: [
    { href: "https://redocly.com/pricing", label: "Pricing" },
    {
      href: "https://redocly.com/docs/realm/reunite/project/use-editor",
      label: "Reunite editor",
    },
    {
      href: "https://redocly.com/docs/realm/config/ai-assistant",
      label: "AI assistant",
    },
    { href: "https://redocly.com/docs/realm/config/mcp", label: "MCP server" },
    { href: "https://redocly.com/docs/realm/config/seo", label: "llms.txt" },
    { href: "https://redocly.com/docs/cli/commands/lint", label: "Linting" },
  ],
  summary:
    "Redocly hosts Realm docs on per-seat plans with a page allowance. Blume renders the same OpenAPI, AsyncAPI, and GraphQL specs beside your guides, free and on any host, while `redocly lint` keeps checking your specs.",
  tagline: "Keep Redocly's linter, own your docs.",
};

const vuepress: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Every `README.md` becomes `index.md` at the same folder URL, and the links to it are rewritten to the folder.",
        title: "README indexes become index pages.",
      },
      {
        body: "`::: tip` containers become `:::` directives, badge text moves inside `<Badge>`, and `<code-group>` blocks become CodeGroup, in every language.",
        title: "Containers, badges, and code groups convert.",
      },
      {
        body: "Each sidebar becomes a header tab, and its groups become folders or `(group)` folders with a `meta.ts`, so no page URL changes.",
        title: "Sidebars move into folders.",
      },
      {
        body: "Every old `.html` URL redirects to its page, and a script pins each heading's old anchor, translated pages included.",
        title: "Old URLs and anchors keep working.",
      },
    ],
    mappings: [
      { from: ".vuepress/config.js", to: "blume.config.ts" },
      { from: "guide/README.md", to: "guide/index.md" },
      { from: "::: danger STOP", to: ":::danger[STOP]" },
      { from: "<code-group>", to: "<CodeGroup>" },
      { from: '<Badge type="error">', to: '<Badge variant="danger">' },
      { from: "<<< @/path/file.js{2}", to: '<include meta="{2}">' },
      { from: "/guide/assets.html", to: "/guide/assets" },
    ],
    tagline: "Your URLs stay put, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "VuePress 1 is in maintenance mode, and its last release, 1.9.10, shipped in August 2023. VuePress 2 is maintained by the community VuePress team and has been a release candidate since November 2023, with 2.0.0-rc.31 in July 2026.",
      question: "Is VuePress still maintained?",
    },
    {
      answer:
        "Both keep Vue in your pages, which makes them the closer step if you rely on it. Blume trades the Vue app for a folder of Markdown, with search, llms.txt, an MCP server, API references, and versioning built in rather than added as plugins.",
      question: "Why move to Blume instead of VuePress 2 or VitePress?",
    },
    {
      answer:
        "Yes. `npx blume migrate vuepress --codex` renames README indexes, converts containers, badges, and code groups, rebuilds sidebars as folders, and redirects every old `.html` URL. It's written for VuePress 1; VuePress 2 sites go through the same command, but that path hasn't been run end to end.",
      question: "Can I keep my VuePress Markdown?",
    },
    {
      answer:
        "Yes, as islands, once they run on Vue 3. VuePress 1 components are Vue 2, so each needs a port, and a component that reads `$page`, `$site`, or the router has to be rewritten, since it can't run outside VuePress.",
      question: "Can I keep my Vue components?",
    },
    {
      answer:
        "The Vue app around your Markdown: themes and layout overrides, `enhanceApp.js`, Markdown slots, and Vue 2 components that weren't ported. The PWA, flowchart blocks that weren't redrawn, heading-only sidebars, and your DocSearch index don't carry over either, and the agent reports each one.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "VuePress compiles each page as a Vue component, so template syntax, directives, and global components work right in the Markdown. Blume pages are MDX, with Vue components as islands.",
      title: "You want Vue in every page.",
    },
    {
      body: "VuePress's official ecosystem has plugins for PWA, comments, watermarks, charts, and slides, plus five search plugins, and vuepress-theme-hope adds encrypted pages on top.",
      title: "You want a plugin for everything.",
    },
    {
      body: "The official blog and feed plugins, and vuepress-theme-hope's blog, give you article lists, categories, tags, and RSS, Atom, and JSON feeds. Blume gives posts RSS, but you build the index page yourself.",
      title: "You run a blog beside your docs.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "`.vuepress/config` with a bundler, a theme, and a plugin per feature",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT), maintained by the community VuePress team",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Plugins: local title and heading search, full-text slimsearch, or DocSearch",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt and Markdown pages through the official llms plugin; no official MCP server",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "No OpenAPI plugin in the official ecosystem",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "No versioning plugin in the official ecosystem",
    },
    {
      blume: "Blog and changelog page types, with RSS",
      label: "Blog and changelog",
      them: "Official blog and feed plugins; a ready-made blog in vuepress-theme-hope",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Built-in i18n with locale folders and a language switcher",
    },
  ],
  id: "vuepress",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and VuePress on release status, search, agent features, API references, and blogs, and see how an agent migrates your VuePress docs to Blume.",
    title: "Blume vs VuePress: a VuePress alternative with no Vue app",
  },
  source: sourceById("vuepress"),
  sources: [
    {
      href: "https://github.com/vuejs/vuepress#status",
      label: "VuePress 1 status",
    },
    {
      href: "https://vuepress.vuejs.org/guide/getting-started.html",
      label: "VuePress 2 RC",
    },
    {
      href: "https://ecosystem.vuejs.press/plugins/search/",
      label: "Search plugins",
    },
    {
      href: "https://ecosystem.vuejs.press/plugins/ai/llms.html",
      label: "llms.txt plugin",
    },
    {
      href: "https://ecosystem.vuejs.press/plugins/blog/",
      label: "Blog plugins",
    },
    { href: "https://vuepress.vuejs.org/guide/i18n.html", label: "i18n" },
  ],
  summary:
    "VuePress 1 is in maintenance mode, and VuePress 2 has been a release candidate since 2023. Blume turns the same Markdown into a site with search, llms.txt, API references, and versioning built in, and an agent moves it with a redirect for every old URL.",
  tagline: "VuePress docs, without the Vue app.",
};

const docus: CompareTool = {
  carryOver: {
    items: [
      {
        body: "A bundled codemod turns callouts into `:::` directives and cards, steps, tabs, code groups, and fields into Blume components, and makes prose MDX-safe.",
        title: "MDC becomes MDX.",
      },
      {
        body: "Each `.navigation.yml` becomes a `meta.ts`, page `navigation` keys become `sidebar`, and sub-navigation sections become header tabs.",
        title: "Navigation stays in folders.",
      },
      {
        body: "Both tools strip number prefixes from file names, so most URLs carry over, and `routeRules` redirects and old `/raw/` Markdown URLs move to `redirects`.",
        title: "Your URLs keep working.",
      },
      {
        body: "On a server deployment, the agent keeps the assistant on the same model and the MCP server at `/mcp`, and publishes your `skills/` folder.",
        title: "The assistant and MCP server stay.",
      },
    ],
    mappings: [
      { from: "app.config.ts", to: "blume.config.ts" },
      { from: ".navigation.yml", to: "meta.ts" },
      { from: "::caution", to: ":::danger" },
      { from: "::card-group", to: "<CardGroup>" },
      { from: "::field", to: "<ResponseField>" },
      { from: "navigation.title", to: "sidebar.label" },
      { from: '"i-lucide-zap"', to: '"zap"' },
    ],
    tagline: "MDC becomes MDX, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Docus is a Nuxt layer, so your docs are a Nuxt app: you configure it in `app.config.ts` and `nuxt.config.ts` and extend it with Vue components and Nuxt modules. Blume turns a folder of Markdown into the whole site with no app code, and builds in the API references and versioning that Docus leaves out.",
      question: "What's the difference between Blume and Docus?",
    },
    {
      answer:
        "Yes. `npx blume migrate docus --codex` runs a codemod that turns MDC callouts, cards, steps, tabs, and code groups into directives and Blume components, writes each `.navigation.yml` as a `meta.ts`, and keeps every old URL working.",
      question: "Can I keep my Docus content?",
    },
    {
      answer:
        "Yes, on a server deployment. The agent keeps your assistant on the same model and your MCP server at `/mcp`, and publishes your `skills/` folder under `/.well-known/agent-skills/`.",
      question: "Does Blume have an AI assistant and an MCP server like Docus?",
    },
    {
      answer:
        "Yes. Blume renders static HTML with Astro, and a Vue component in `islands/` works in any MDX page once you install `@astrojs/vue`. The agent rebuilds your own content components as Markdown, Blume components, or Vue islands.",
      question: "Can I still use Vue components?",
    },
    {
      answer:
        "Nuxt UI theme overrides and landing-page decorations, the `code-tree` file browser and `code-preview` live rendering, server routes, and your MCP server's own tools and prompts. The agent reports each one so you can decide what to do with it.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Docus is a Nuxt layer, so your docs can use Vue components in Markdown, Nuxt modules, custom pages, and server routes, or sit inside your existing Nuxt app.",
      title: "You build with Vue and Nuxt.",
    },
    {
      body: "Nuxt Studio, a free, self-hostable module, lets teammates edit pages on the live site and commit the changes to Git. Blume is Markdown and MDX in your repo.",
      title: "You want a visual editor.",
    },
    {
      body: "Docus builds its MCP server on the Nuxt MCP Toolkit, so you can add tools, resources, prompts, and extra endpoints in `server/mcp/`. Blume's server has a fixed set of read-only tools.",
      title: "You want your own MCP tools.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "A Nuxt app: `content/`, plus `app.config.ts` and `nuxt.config.ts`",
    },
    {
      blume: "Astro, generated and run for you",
      label: "Built on",
      them: "Nuxt 4, Nuxt Content, and Nuxt UI, as a Nuxt layer",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT)",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "llms.txt, Markdown pages, agent skills, and an MCP server, on by default",
    },
    {
      blume:
        "An in-page assistant on the model you choose, billed by your provider",
      label: "AI assistant",
      them: "A built-in assistant on Vercel AI Gateway, or your own AI SDK route",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "Not built in; an open issue covers adding OpenAPI through Scalar",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Not built in",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Built-in i18n through `@nuxtjs/i18n`, with a folder per locale",
    },
  ],
  id: "docus",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Docus on setup, agent features, API references, versioning, and i18n, and see how an agent migrates your Docus site to Blume.",
    title: "Blume vs Docus: a Docus alternative with no Nuxt app",
  },
  source: sourceById("docus"),
  sources: [
    {
      href: "https://docus.dev/en/getting-started/project-structure",
      label: "Project structure",
    },
    { href: "https://docus.dev/en/ai/llms", label: "llms.txt and Markdown" },
    { href: "https://docus.dev/en/ai/mcp", label: "MCP server" },
    { href: "https://docus.dev/en/ai/assistant", label: "Assistant" },
    {
      href: "https://docus.dev/en/concepts/internationalization",
      label: "Internationalization",
    },
    {
      href: "https://github.com/nuxt-content/docus/issues/1156",
      label: "OpenAPI issue",
    },
  ],
  summary:
    "Docus makes your docs a Nuxt app you configure and extend. Blume turns a folder of Markdown into the whole site, with the llms.txt, MCP server, and assistant Docus users expect, plus API references and versioning, and no app to maintain.",
  tagline: "The Docus alternative with no Nuxt app.",
};

const docsify: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Each page becomes static HTML at its own URL, so readers and search engines get the content without running any JavaScript.",
        title: "Pages are built ahead of time.",
      },
      {
        body: "Each `_sidebar.md` group becomes a folder with a `meta.ts` in sidebar order, the navbar becomes header tabs and links, and the cover page becomes the top of your home page.",
        title: "The sidebar becomes folders.",
      },
      {
        body: "A small script sends every old `#/` route and `?id=` anchor to its new page and heading, and old heading ids are pinned where Blume's differ.",
        title: "Old #/ links still land.",
      },
      {
        body: "A codemod turns `!>` and `?>` into directives, docsify-tabs into Tabs, and `':include'` links into includes, and search, copy-code, pagination, and zoom are built in.",
        title: "Callouts, tabs, and includes convert.",
      },
    ],
    mappings: [
      { from: "window.$docsify", to: "blume.config.ts" },
      { from: "_sidebar.md", to: "meta.ts" },
      { from: "README.md", to: "index.md" },
      { from: "!>", to: ":::warning" },
      { from: "<!-- tabs:start -->", to: "<Tabs>" },
      { from: "':include'", to: "<include>" },
      { from: "#/setup?id=install", to: "/setup#install" },
    ],
    tagline: "Your Markdown comes along, and every old link still lands.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Docsify fetches and renders your Markdown in the browser each time a page loads, from one `index.html` with no build. Blume builds every page into static HTML ahead of time, and adds llms.txt, an MCP server, API references, and versioning, none of which Docsify builds in.",
      question: "What's the difference between Blume and Docsify?",
    },
    {
      answer:
        "Docsify's own docs call its default hash URLs not so search-engine friendly, and suggest history mode with server rewrites instead. Its server renderer is deprecated on npm while the team investigates SSR and static generation. Blume serves every page as HTML at its own URL, with a sitemap.",
      question: "Does rendering in the browser hurt SEO?",
    },
    {
      answer:
        "Yes. `npx blume migrate docsify --codex` runs a codemod that converts `!>` and `?>` callouts, docsify-tabs, and `':include'` links, turns each page's first H1 into its title, and rebuilds `_sidebar.md` as folders.",
      question: "Can I keep my Docsify Markdown?",
    },
    {
      answer:
        "Yes. A server never sees the part of a URL after `#`, so the agent adds a small script to every page that sends old `#/` routes and `?id=` anchors to the new page and heading. It also pins each old heading id where Blume's differs.",
      question: "Will my old #/ links still work?",
    },
    {
      answer:
        "Vue widgets and page scripts, comment plugins, custom marked renderers and `breaks: true`, dynamic virtual routes, the Docsify theme and cover background, and link attributes like `:size`. Remote aliases and includes become copies or a build-time content source, and the agent reports each one.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Docsify is one `index.html` that loads from a CDN, so you edit Markdown, push, and any static host serves it, with no Node.js toolchain. Blume needs Node.js and a build.",
      title: "You want no build step.",
    },
    {
      body: "Docsify runs Vue templates, data, and components straight from your Markdown pages with one script tag. Blume runs Vue as islands, with `@astrojs/vue` installed.",
      title: "You want Vue in your Markdown.",
    },
    {
      body: "Docsify aliases and includes can fetch Markdown from another repository each time a page loads, so readers always see its latest version. Blume reads remote content at build time.",
      title: "Your pages pull content live.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "One `index.html` with `window.$docsify`, plus `_sidebar.md` and plugin scripts",
    },
    {
      blume: "Static HTML at build time by default, or a server build",
      label: "Rendering",
      them: "In the browser on each page load, with no build step",
    },
    {
      blume: "A real URL per page, with a sitemap and structured data",
      label: "URLs and SEO",
      them: "`#/` hash URLs by default, which its docs call not search-engine friendly",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT)",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "A bundled plugin that indexes pages in the browser",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "Not built in; your `.md` files are served as they are",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "Not built in",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Locale folders and navbar links, with per-page fallback",
    },
  ],
  id: "docsify",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Docsify on rendering, SEO, search, agent features, and API references, and see how an agent migrates your Docsify site to Blume.",
    title: "Blume vs Docsify: a Docsify alternative with real URLs",
  },
  source: sourceById("docsify"),
  sources: [
    { href: "https://docsify.js.org/#/quickstart", label: "Quick start" },
    {
      href: "https://docsify.js.org/#/configuration?id=routermode",
      label: "Router mode",
    },
    {
      href: "https://docsify.js.org/#/plugins?id=full-text-search",
      label: "Search plugin",
    },
    {
      href: "https://docsify.js.org/#/configuration?id=fallbacklanguages",
      label: "Languages",
    },
    {
      href: "https://www.npmjs.com/package/docsify-server-renderer",
      label: "Server renderer",
    },
    {
      href: "https://github.com/docsifyjs/docsify/releases/tag/v5.0.0",
      label: "v5.0.0 release",
    },
  ],
  summary:
    "Docsify renders your Markdown in the browser from a single `index.html`. Blume builds the same Markdown into static pages with real URLs, adds llms.txt, an MCP server, API references, and versioning, and keeps every old `#/` link working.",
  tagline: "Docsify's simplicity, with real pages.",
};

const mdbook: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Parts become sidebar headings, parent chapters become collapsible groups, and every chapter keeps its path.",
        title: "SUMMARY.md becomes folders.",
      },
      {
        body: "The agent adds a redirect from every old `.html` URL, carries over `[output.html.redirect]`, and pins any heading anchor that changed.",
        title: "Old .html links redirect.",
      },
      {
        body: "`{{#include}}` anchors and line ranges become excerpts that a bundled script writes from your source before every build.",
        title: "Included code stays generated.",
      },
      {
        body: "Hidden Rust lines and fence attributes like `rust,ignore` are stripped, and mdbook-admonish blocks become `:::` callouts.",
        title: "Code blocks and admonitions convert.",
      },
    ],
    mappings: [
      { from: "book.toml", to: "blume.config.ts" },
      { from: "SUMMARY.md", to: "meta.ts" },
      { from: "guide/README.md", to: "guide/index.md" },
      { from: "/guide/setup.html", to: "/guide/setup" },
      { from: "{{#include f.rs:main}}", to: "<include>" },
      { from: "```rust,ignore", to: "```rust" },
      { from: "```admonish tip", to: ":::tip" },
    ],
    tagline: "Your chapters keep their paths, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "mdBook makes a clean book from one binary, but llms.txt, versioning, translations, and API references aren't built in. Blume ships all four, plus Markdown mirrors and an MCP server, from the same folder of Markdown.",
      question: "Why move from mdBook?",
    },
    {
      answer:
        "Yes. `npx blume migrate mdbook --codex` rebuilds `SUMMARY.md` as folders that keep each chapter's path, adds a redirect from every old `.html` URL, and pins any heading anchor that changed.",
      question: "Can I keep my chapters and URLs?",
    },
    {
      answer:
        "Code includes become excerpts that a bundled script generates from your source before every build, so the code cargo compiles is still the code readers see. Blume doesn't run `mdbook test` or the play button, so examples written only in a page aren't compiled any more.",
      question: "What happens to my includes and tested examples?",
    },
    {
      answer:
        "To build, yes: Blume needs Node.js 22.19 or later, and a static build needs nothing at runtime. The agent puts `package.json` beside `book.toml`, so it stays out of your Rust repo's root.",
      question: "Do I need Node.js?",
    },
    {
      answer:
        "Running and testing code (the play button, editable examples, and `mdbook test`), the hidden-line toggle, the whole-book print page, chapter numbers, separators, draft chapters, the theme switcher, and whole-book PDF or EPUB output. The agent reports each one, along with any plugin it removed.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "`mdbook test` compiles the Rust samples in your book, and a play button runs them and shows the output. Blume renders code blocks without compiling or running them.",
      title: "You test your examples with mdBook.",
    },
    {
      body: "mdBook installs as a single prebuilt binary for Windows, macOS, and Linux, so a Rust project's docs need no JavaScript toolchain. Blume needs Node.js 22.19 or later to build.",
      title: "You want one binary and no Node.js.",
    },
    {
      body: "mdBook numbers chapters in the sidebar, prints the whole book as one page, and renders other formats through backends. Blume is a docs site, and exports one page at a time.",
      title: "You're writing a book.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "`book.toml`, a hand-written `SUMMARY.md`, and each plugin's executable",
    },
    {
      blume: "Node.js 22.19 or later",
      label: "Runtime",
      them: "One Rust binary, prebuilt for Windows, macOS, and Linux",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MPL-2.0)",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Built-in text search that runs in the browser",
    },
    {
      blume: "Highlighted code blocks, not compiled or run",
      label: "Code examples",
      them: "`mdbook test` compiles Rust samples, and a play button runs them",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "Not built in",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Not built in",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "One language per book; translations through the mdbook-i18n-helpers plugin",
    },
  ],
  id: "mdbook",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and mdBook on setup, search, code examples, agent features, versioning, and translations, and see how an agent migrates your mdBook to Blume.",
    title: "Blume vs mdBook: an mdBook alternative for docs sites",
  },
  source: sourceById("mdbook"),
  sources: [
    {
      href: "https://rust-lang.github.io/mdBook/guide/installation.html",
      label: "Installation",
    },
    {
      href: "https://rust-lang.github.io/mdBook/cli/test.html",
      label: "mdbook test",
    },
    {
      href: "https://rust-lang.github.io/mdBook/format/configuration/renderers.html",
      label: "Search and output",
    },
    {
      href: "https://github.com/rust-lang/mdBook/wiki/Third-party-plugins",
      label: "Plugins",
    },
    {
      href: "https://github.com/rust-lang/mdBook/issues/2245",
      label: "Versioning issue",
    },
    {
      href: "https://github.com/google/mdbook-i18n-helpers",
      label: "i18n helpers",
    },
  ],
  summary:
    "mdBook turns Markdown into a clean, navigable book from one Rust binary. Blume turns the same Markdown into a docs site with llms.txt, an MCP server, API references, versioning, and translations built in, and an agent does the move.",
  tagline: "Your mdBook, as a full docs site.",
};

const jekyll: CompareTool = {
  carryOver: {
    items: [
      {
        body: "Each `{: .note }` attribute list becomes a `:::` directive, matched by the callout's name or color in `_config.yml`, and labels become badges.",
        title: "Callouts become directives.",
      },
      {
        body: "Just the Docs' `parent` and `nav_order` front matter becomes folders and `meta.ts` files, rebuilt from your old build without moving a URL.",
        title: "The sidebar moves into folders.",
      },
      {
        body: "Markdown includes become `<include>`, plain `{{ site.x }}` values become variables, and `{% link %}` and relative links become routes.",
        title: "Liquid becomes includes and variables.",
      },
      {
        body: "`redirect_from` and `.html` URLs become redirects, and a script pins every old heading anchor that Blume would spell differently.",
        title: "Old URLs and anchors keep working.",
      },
    ],
    mappings: [
      { from: "_config.yml", to: "blume.config.ts" },
      { from: "{: .warning }", to: ":::warning" },
      { from: "{: .label }", to: "<Badge>" },
      { from: "nav_order", to: "meta.ts" },
      { from: "{% include x.md %}", to: "<include>" },
      { from: "{{ site.title }}", to: "{{title}}" },
      { from: "redirect_from", to: "redirects" },
    ],
    tagline: "Every URL stays put, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Jekyll's latest release is 4.4.1, from January 2025, and GitHub Pages' own build runs Jekyll 3.10.0 with allowlisted plugins only. llms.txt, versioning, translations, and API references aren't built into Jekyll or Just the Docs. Blume ships all four, with no Ruby toolchain to install.",
      question: "Why move from Jekyll and Just the Docs?",
    },
    {
      answer:
        "Yes. `npx blume migrate jekyll --codex` runs a codemod that turns callout attribute lists into `:::` directives, Markdown includes into `<include>`, and `parent` and `nav_order` into folders and `meta.ts`, without moving a URL.",
      question: "Can I keep my Just the Docs pages?",
    },
    {
      answer:
        "No. Blume runs on Node.js 22.19 or later, so the `Gemfile` and Bundler go, and the agent swaps `bundle exec jekyll build` in your CI for the Blume build.",
      question: "Do I still need Ruby?",
    },
    {
      answer:
        "Yes. `blume build` outputs static files, and a GitHub Actions workflow deploys them to Pages, with your `baseurl` as `deployment.base`. The assistant and the MCP server need a server host, such as Vercel, Netlify, Cloudflare, or Node.",
      question: "Can my docs stay on GitHub Pages?",
    },
    {
      answer:
        "Just the Docs' layouts and color schemes beyond the accent, `_sass` rules with no Blume equivalent, callout labels that only name the type, Kramdown abbreviations and site-wide code line numbers, page scripts and jQuery widgets, and plugins with no equivalent. Liquid logic and `_data` loops become static content, and the agent reports each item so you can decide what to do with it.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "GitHub Pages builds a Jekyll site straight from a branch, with no workflow to write, as long as it sticks to the allowlisted plugins. Blume on GitHub Pages builds in an Actions workflow.",
      title: "You want GitHub to build it for you.",
    },
    {
      body: "Jekyll plugins are Ruby: generators, converters, Liquid tags and filters, and build hooks, from a gem or a `_plugins` folder. A Ruby team can extend the build in the language it already writes.",
      title: "You extend your site in Ruby.",
    },
    {
      body: "Jekyll loads YAML, JSON, CSV, and TSV from `_data` and loops over it with Liquid in any page. Blume pages are Markdown and MDX, so the migration writes those loops out as static content.",
      title: "You build pages from data files.",
    },
  ],
  glance: [
    {
      blume: "A folder of Markdown, plus one optional config file",
      label: "You maintain",
      them: "A Ruby site: `_config.yml`, a `Gemfile`, and Liquid includes",
    },
    {
      blume: "Free and open source (MIT)",
      label: "License",
      them: "Free and open source (MIT), Jekyll and Just the Docs alike",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "Any static host; GitHub Pages' default build runs allowlisted plugins only",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "Lunr search built into Just the Docs, with no results page",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "Community plugins for llms.txt and Markdown copies, outside GitHub Pages' allowlist",
    },
    {
      blume: "OpenAPI, AsyncAPI, and GraphQL, with a Try it playground",
      label: "API references",
      them: "Not built into Jekyll or Just the Docs",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Not built in; an open Just the Docs request since 2021",
    },
    {
      blume: "`blume translate` fills in every locale with your coding agent",
      label: "Languages",
      them: "Community plugins such as Polyglot; Just the Docs has no i18n",
    },
  ],
  id: "jekyll",
  kind: "framework",
  meta: {
    description:
      "Compare Blume and Jekyll with Just the Docs on setup, hosting, search, agent features, and versioning, and see how an agent migrates your Jekyll docs to Blume.",
    title: "Blume vs Jekyll: a Just the Docs alternative without Ruby",
  },
  source: sourceById("jekyll"),
  sources: [
    { href: "https://jekyllrb.com/news/", label: "Releases" },
    {
      href: "https://jekyllrb.com/docs/installation/",
      label: "Requirements",
    },
    {
      href: "https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll",
      label: "GitHub Pages plugins",
    },
    {
      href: "https://pages.github.com/versions/",
      label: "GitHub Pages versions",
    },
    { href: "https://just-the-docs.com/docs/search/", label: "Search" },
    {
      href: "https://github.com/just-the-docs/just-the-docs/issues/728",
      label: "Versioning request",
    },
  ],
  summary:
    "Just the Docs on Jekyll gives you a Ruby site that GitHub Pages can build for you. Blume turns the same Markdown into a site with llms.txt, API references, versioning, and translations built in, and no Ruby to install.",
  tagline: "Jekyll docs, without the Ruby toolchain.",
};

const githubWiki: CompareTool = {
  carryOver: {
    items: [
      {
        body: "`/wiki/Getting-Started` becomes `/getting-started`: one flat, lowercase route per page, wherever its file sat in the wiki.",
        title: "Every page gets a clean URL.",
      },
      {
        body: "Each `_Sidebar.md` group becomes a folder with a `meta.ts`, and pages the sidebar didn't list go in a collapsed More pages group.",
        title: "The sidebar becomes folders.",
      },
      {
        body: "`[[Page Name]]` links become Markdown links, alerts become `:::` callouts, and images stored in the wiki move beside the pages.",
        title: "Links, alerts, and images convert.",
      },
      {
        body: "The old URLs stay on github.com, so the agent prepares a link stub for every wiki page, for you to push once the new site is live.",
        title: "A stub for every old page.",
      },
    ],
    mappings: [
      { from: "Home.md", to: "docs/index.md" },
      { from: "/wiki/Getting-Started", to: "/getting-started" },
      { from: "_Sidebar.md", to: "(group)/meta.ts" },
      { from: "[[Page Name]]", to: "[Page Name](/page-name)" },
      { from: "[[text|Page Name]]", to: "[text](/page-name)" },
      { from: "> [!WARNING]", to: ":::warning" },
      { from: "_Footer.md", to: "footer.links" },
    ],
    tagline: "Your pages stay Markdown, and an agent does the move.",
  },
  checked: "October 7, 2026",
  faq: [
    {
      answer:
        "Search engines index a wiki only once it has 500 or more stars and editing is restricted to collaborators, and GitHub's APIs and MCP server can't read wiki pages. Blume publishes your docs as a site of their own, with a sitemap, llms.txt, Markdown mirrors, and changes that go through pull requests with the code.",
      question: "Why move from a GitHub wiki?",
    },
    {
      answer:
        "Yes. `npx blume migrate github-wiki --codex` gives every page a clean URL, converts `[[wiki links]]` and alerts, moves the wiki's images beside the pages, and rebuilds `_Sidebar.md` as folders.",
      question: "Can I keep my wiki pages?",
    },
    {
      answer:
        "No. The old pages stay on github.com, where Blume's redirects can't reach. The agent prepares a one-line link stub for every wiki page, so once you push them, old links from issues and bookmarks land one click from the new page.",
      question: "Will my old wiki links redirect?",
    },
    {
      answer:
        "Yes. The docs can live in a folder of your main repository and change in the same pull requests as the code, and `blume build` outputs static files that GitHub Pages can serve from an Actions workflow.",
      question: "Can my docs stay on GitHub?",
    },
    {
      answer:
        "Editing in the browser, each page's revision history (unless you bring it in with `git subtree`), the Pages list, footer text other than a copyright line, sidebar prose, image sizes, and GeoJSON maps and 3D models. Old wiki URLs never redirect, so the agent prepares stubs instead and reports everything it dropped.",
      question: "What doesn't the migration carry over?",
    },
  ],
  fit: [
    {
      body: "Every GitHub repository comes with a wiki: no config, no build, and no deploy. Pages go live as soon as you save them.",
      title: "You want zero setup.",
    },
    {
      body: "Each wiki page has an Edit button on GitHub, and a public wiki can open editing to anyone with a GitHub account. Blume pages are files in your repository, changed through Git.",
      title: "You want anyone to edit in the browser.",
    },
    {
      body: "A private repository's wiki is readable only by people with access to the repository, behind GitHub's sign-in. Blume has no sign-in of its own, so a private Blume site relies on your host's access protection.",
      title: "Your docs are private to the repository.",
    },
  ],
  glance: [
    {
      blume: "Free and open source, with no seat limits",
      label: "Price",
      them: "Free in public repositories; private wikis need GitHub Pro, Team, or Enterprise",
    },
    {
      blume: "Any host: Vercel, Netlify, Cloudflare, Node, or static files",
      label: "Hosting",
      them: "On github.com beside your code, in GitHub's own layout",
    },
    {
      blume: "Markdown and MDX in your repo, in any editor",
      label: "Editing",
      them: "A web editor on GitHub, or Git pushes to the wiki's own repository",
    },
    {
      blume: "Folders, with `meta.ts` for order and titles",
      label: "Navigation",
      them: "An alphabetical page list, plus a hand-written `_Sidebar.md` and `_Footer.md`",
    },
    {
      blume:
        "Local search with no keys, or Pagefind, Algolia, and more by adapter",
      label: "Search",
      them: "GitHub's site search filtered to wikis, plus a page filter",
    },
    {
      blume: "A sitemap, canonical URLs, Open Graph cards, and JSON-LD",
      label: "Search engines",
      them: "Indexed only with 500+ stars and editing restricted to collaborators",
    },
    {
      blume:
        "llms.txt, Markdown mirrors, and a JSON API by default; an opt-in MCP server",
      label: "Agent features",
      them: "GitHub's APIs and MCP server don't read wikis; agents can clone its Git repo",
    },
    {
      blume: "`blume version` snapshots with a switcher and scoped search",
      label: "Versioning",
      them: "Revision history for each page, with diffs and reverts",
    },
  ],
  id: "github-wiki",
  kind: "hosted",
  meta: {
    description:
      "Compare Blume and GitHub Wiki on price, editing, search, search engine indexing, and agent features, and see how an agent migrates your wiki to Blume.",
    title: "Blume vs GitHub Wiki: when your docs outgrow the wiki",
  },
  source: sourceById("github-wiki"),
  sources: [
    {
      href: "https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis",
      label: "About wikis",
    },
    {
      href: "https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages",
      label: "Editing",
    },
    {
      href: "https://docs.github.com/en/communities/documenting-your-project-with-wikis/changing-access-permissions-for-wikis",
      label: "Permissions",
    },
    {
      href: "https://docs.github.com/en/communities/documenting-your-project-with-wikis/creating-a-footer-or-sidebar-for-your-wiki",
      label: "Sidebar and footer",
    },
    {
      href: "https://docs.github.com/en/search-github/searching-on-github/searching-wikis",
      label: "Search",
    },
    {
      href: "https://github.com/github/github-mcp-server/issues/694",
      label: "MCP server",
    },
  ],
  summary:
    "A GitHub wiki is the fastest place to start: no setup, a web editor, and pages beside your code. Blume turns the same Markdown into a docs site that search engines and agents can read, with clean URLs, llms.txt, and changes reviewed in pull requests.",
  tagline: "When your docs outgrow the wiki.",
};

export const tools: CompareTool[] = [
  mintlify,
  gitbook,
  docusaurus,
  mkdocs,
  readme,
  fumadocs,
  starlight,
  vitepress,
  nextra,
  fern,
  redocly,
  docus,
  vuepress,
  mdbook,
  jekyll,
  docsify,
  githubWiki,
];

/** A compare tool by id, for the route file that renders its page. */
export const compareTool = (id: string): CompareTool => {
  const tool = tools.find((entry) => entry.id === id);
  if (!tool) {
    throw new Error(`Unknown compare tool: ${id}`);
  }
  return tool;
};

/** When the agent-readiness scores were taken (as reported on the homepage). */
export const scoresDate = "September 20, 2026";
