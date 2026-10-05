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
  tagline: "The Nextra alternative with no app to maintain.",
};

export const tools: CompareTool[] = [
  mintlify,
  fumadocs,
  docusaurus,
  starlight,
  nextra,
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
