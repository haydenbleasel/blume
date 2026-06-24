# Mintlify compatibility audit

This checklist tracks the "swap `mintlify` for `blume`" local-run litmus test.
The bridge is intentionally scoped to previewing and building existing Mintlify
docs content with Blume. Hosted platform behavior, quality commands, live API
playground execution, analytics, auth, and Mintlify AI/agent-output parity are
out of scope for this checklist.

Audit sources:

- <https://www.mintlify.com/docs/components>
- <https://www.mintlify.com/docs/api-playground/openapi-setup>
- <https://www.mintlify.com/docs/api-playground/asyncapi-setup>
- <https://www.mintlify.com/docs/create/reusable-snippets>
- <https://www.mintlify.com/docs/create/personalization>
- <https://www.mintlify.com/docs/organize/settings-reference>
- <https://www.mintlify.com/docs/organize/pages>
- <https://www.mintlify.com/docs/guides/custom-layouts>
- Component detail pages linked from the Mintlify component index

Legend:

- `[pass]` Works as a drop-in for the common documented shape.
- `[partial]` Builds and renders, but behavior, props, layout, or generated output is not Mintlify-equivalent.
- `[missing]` Does not work without a transform, runtime feature, or new component.
- `[out-of-scope]` Deliberately excluded from the render-only dependency-swap test.

## Starter litmus

- [x] [pass] `examples/mintlify` exists next to `examples/basic`.
- [x] [pass] Example content follows `mintlify/starter` shape: root `docs.json`, root MDX pages, root favicon/logo assets, and no Blume config.
- [x] [pass] `examples/mintlify/package.json` depends on `blume` instead of `mintlify`.
- [x] [pass] Blume exposes a `mint` CLI alias, so existing Mintlify-style scripts can run after replacing the dependency with `blume`; help output uses `mint` when invoked through that alias.
- [x] [pass] `bun --filter @blume-examples/mintlify build` succeeds through `mint build`.
- [x] [pass] `bun --filter @blume-examples/mintlify dev` serves the starter page through `mint dev` without the generated `.blume/.astro` content-store reload loop.
- [x] [out-of-scope] Mintlify maintenance commands such as `mint validate`, `mint broken-links`, `mint a11y`, and `mint rename` are intentionally not implemented; this audit only tracks rendering compatibility.
- [x] [partial] `mint dev --no-open` serves the same fixture for visual A/B after the home page uses plain text instead of `{{product-name}}`; the current Mintlify CLI errored with `Could not parse expression with acorn` when that documented variable placeholder was present in the control fixture.
- [x] [pass] Root-level Mintlify assets are copied into the generated public directory.
- [x] [pass] Root-level `docs.json` is used when no native `blume.config.*` file exists.

## Visual A/B checks

- [x] [partial] Captured home, component-smoke, and generated API pages from the same fixture with Mintlify and Blume dev servers.
- [x] [partial] Home page content and navigation render, including Mintlify-style frontmatter title and description on pages without an H1.
- [x] [partial] Linked cards no longer inherit prose link underlines, and typed callouts use default type-specific backgrounds and borders.
- [x] [partial] `contextual.options` renders configured built-in actions for `copy`, `view`, common AI tools, MCP copy/install entries, and editor MCP links; copy/MCP/AI actions were verified in-browser. Markdown view, PDF/spec download, assistant, and MCP installation remain client-side fallbacks rather than Mintlify backend-equivalent integrations.
- [x] [partial] `navbar.links` and `navbar.primary` render in the default header and mobile drawer; exact Mintlify ordering and icon libraries are still partial.
- [x] [partial] `footer.socials` renders social links in the default footer, and `footer.links` renders documented footer link columns.
- [x] [partial] Global `docs.json.banner` renders on every page with Markdown links/bold/italic, type colors, optional custom colors, and dismiss persistence keyed by banner content.
- [x] [partial] Home page is still not visually equivalent to Mintlify: header/sidebar treatment, contextual option dropdown items beyond copy, powered-by branding, and exact spacing differ.
- [x] [partial] Component-smoke page builds and renders, but Blume is not visually equivalent to Mintlify: component spacing, panel treatment, and mobile flow still differ.
- [x] [partial] Generated OpenAPI routes match the common Mintlify `operationId` slug shape (`/api-reference/list-flowers`). Blume renders sidebar method badges, a Mintlify-like endpoint shell, generated cURL request panels, response panels, nested request/response schema fields from local `$ref`s, and a wider API right rail. Live `Try it` forms, proxy execution, playground auth inputs, hosted auth/group-aware behavior, polymorphic schema picker UI, and exact response/parameter styling are outside the local rendering bridge.
- [x] [partial] Refreshed screenshots:
  - `/tmp/blume-mintlify-ab/screenshots/ab-contact-sheet-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/mintlify-home-desktop-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/blume-home-desktop-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/mintlify-components-desktop-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/blume-components-desktop-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/mintlify-api-list-flowers-desktop-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/blume-api-list-flowers-desktop-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/mintlify-home-mobile-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/blume-home-mobile-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/mintlify-components-mobile-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/blume-components-mobile-latest.png`
  - `/tmp/blume-mintlify-ab/screenshots/metadata-latest.json`
- [x] [partial] Mobile drawer opens/closes reliably and exposes desktop-hidden section links, global anchors, navbar links, and the primary CTA; verified with `agent-browser` at a mobile viewport.
- [x] [partial] Right-rail examples and panels use a more compact pinned-sidebar treatment with tighter rail spacing, shared panel chrome, capped code height, and mobile inline fallback. Exact Mintlify spacing and interaction polish remain partial.

## Config compatibility

- [x] [pass] `docs.json` root fallback.
- [x] [pass] `$ref` resolution with cycle and root-boundary checks.
- [x] [pass] `.mintignore`, default Mintlify output ignores, and generated Blume output ignores (`.blume/`, `dist/`, `.turbo/`) for stable dual Mintlify/Blume dev-server runs.
- [x] [pass] Root content directory mapping for Mintlify projects.
- [x] [pass] Root `custom.css`/`style.css` files are loaded into the generated theme alongside native Blume `theme.css`.
- [x] [partial] `name`, `colors.primary`, `colors.light`, `colors.dark`, `appearance.default`, `appearance.strict`, `logo`, `favicon`, `icons.library`, `redirects`, `seo.indexing`, `seo.metatags`, and `search.prompt` mapped into Blume config. `seo.metatags` renders global `name`/`property` meta tags, `colors.dark` maps to primary action buttons, and `search.prompt` renders in the default search button/input; exact Mintlify hover-state coverage and search modal styling across every component are still partial.
- [x] [partial] `fonts.family`, `fonts.body`, and `fonts.heading` map to Blume body/heading font CSS variables, including optional `source`, `format`, and `weight` for self-hosted `@font-face` output. Mintlify's automatic Google Fonts loading remains partial unless the font is available locally or provided with `source`.
- [x] [partial] `background.color.light` and `background.color.dark` map to Blume light/dark background tokens. `background.image` string/object values map to light/dark CSS background-image tokens, and `background.decoration` renders default-theme `gradient`, `grid`, and `windows` background patterns. Exact Mintlify background artwork and theme-specific placement remain partial.
- [x] [partial] `styling.eyebrows` maps `"section"` and `"breadcrumbs"` into the default page eyebrow renderer; `styling.latex` maps to Blume's existing MDX math/KaTeX support and is covered in `examples/mintlify`; generated dev config allow-lists KaTeX package assets so local preview does not hit Vite font serving errors. `styling.codeblocks` maps `"system"`, `"dark"`, Shiki theme strings, and documented light/dark theme objects into Astro's Shiki config. Mintlify's exact breadcrumb styling, automatic LaTeX detection, and custom TextMate language loading from `styling.codeblocks.languages.custom` remain partial.
- [x] [partial] `contextual.options`, `footer.socials`, and `footer.links` are mapped; configured built-in contextual entries render in the header or TOC location, and documented footer link columns render in the default footer. Copy, Markdown-view fallback, AI links, MCP copy/install commands, editor MCP deeplinks, print-to-PDF fallback, and API-spec opening have client behavior, but Mintlify-hosted assistant/MCP/PDF/spec backend parity is not complete.
- [x] [partial] `navigation.pages`, grouped pages, anchors, navbar links, and navbar primary links are mapped. Navbar links and primary CTAs now stay in a dedicated navbar config and render in the header instead of being folded into section tabs.
- [x] [partial] Root `tabs`, `anchors`, `dropdowns`, `products`, `versions`, `languages`, and tab `menu` entries are covered by fixtures. Tabs and global anchors render as top header sections; tab `menu` entries render as header dropdown menus; root dropdowns/products/versions/languages render as sidebar selector controls. Active root tabs, tab menus, dropdowns, products, versions, languages, and nested tab children select route-specific sidebar branches. Nested sidebar groups now honor Mintlify `expanded`: top-level groups stay open, active nested groups open, `expanded: true` opens by default, and `expanded: false`/omitted nested groups are collapsed. Mintlify group `root` pages render as clickable sidebar group titles and participate in breadcrumbs/pagination without being duplicated as child pages. Mintlify `directory` inheritance for group root pages renders `card` and `accordion` child listings below root page content, and `directory: "none"` disables inherited listings. Sidebar page icons/tags and group icons/tags render through the default theme. Language entries can override banner, footer, and navbar chrome. Exact nested selector chrome and pixel-equivalent directory styling remain partial.
- [x] [partial] Page frontmatter layout and metadata controls `mode`, `toc`, `hideFooterPagination`, `hidden`, `noindex`, `deprecated`, `hideApiMarker`, `groups`, `public`, and `boost` are accepted by the default Blume pipeline. `hidden: true` maps to sidebar hiding plus page `noindex`, `deprecated: true` renders a default-theme marker, and `hideApiMarker: true` suppresses API method badges in navigation. `default`, `wide`, `custom`, `frame`, and `center` are covered in `examples/mintlify`: sidebars, side panels, generated page headers, footer pagination, and footer visibility now follow the documented Mintlify shape. Exact theme-specific `frame` footer treatment, pixel-equivalent spacing, and exact Mintlify search boost ranking remain partial.
- [x] [partial] Page frontmatter SEO controls `canonical`, `keywords`, `noindex`, `robots`, quoted colon meta tags such as `"og:image"`/`"twitter:card"`, and Blume's nested `seo` bridge values render in the default document head. Page-level meta tags override generated defaults where they overlap, and the Mintlify example covers the common documented shape. Mintlify's full automatic SEO matrix, sitemap/robots generation details, and hosted indexing behavior remain partial.
- [x] [partial] `banner` in `docs.json` renders globally with safe Markdown, type/color mapping, and dismiss persistence. Language-specific banners under `navigation.languages` override global banners on matching language routes. Exact Mintlify styling is still partial.
- [x] [pass] `variables` in `docs.json` replace `{{variableName}}` in frontmatter, headings, rendered Markdown/MDX, snippets, and search text. Variable names follow Mintlify's documented alphanumeric-and-hyphen shape. The A/B fixture keeps this out of visible page source because the current Mintlify CLI local preview rejected `{{product-name}}` in `index.mdx` before Blume rendered it.
- [x] [partial] `openapi` on navigation items generates endpoint pages from file paths and URLs into `.blume/api-content`, adds dedicated-section sidebar refs, maps selective endpoint refs such as `GET /flowers`, carries API methods into sidebar badges, accepts `api.playground` without runtime behavior, maps `api.examples`, emits static cURL request examples from OpenAPI `servers`, carries page-level `x-mint.groups` and common `x-mint.metadata` fields into generated frontmatter, injects `x-mint.content` before generated parameter/response docs, honors `x-mint.href` for generated routes and sidebars, renders generated parameter pills from `x-mint.pre`, `x-mint.post`, built-in read/write/deprecated flags, and `api.params.post`, uses OpenAPI tag `x-group` labels while keeping tag-name URL segments, expands local schema `$ref`s, flattens nested object/array fields, merges `allOf` schema fields, renders response-body fields, appends generated endpoint docs for manual `openapi` frontmatter pages, appends schema docs for manual `openapi-schema` pages, renders manual `webhook` frontmatter pages, renders OpenAPI operation callbacks between request body and responses, maps operation `deprecated` into frontmatter/sidebar/page chrome, generates directly accessible `x-hidden` endpoint pages while omitting them from navigation/search, and excludes `x-excluded` endpoint pages. Live playground forms, proxy execution, hosted auth/group-aware site access, automatic webhook navigation generation, exact callback accordion styling, and Mintlify's polymorphic schema picker UI are not equivalent.
- [x] [partial] Manual API pages with `api` frontmatter use `api.mdx.server` to render an endpoint bar while preserving documented `ParamField` and `ResponseField` content in the page. `api.mdx.auth`, page-level `authMethod`, and `playground` are accepted as inert metadata; dynamic JSX props, generated playground inputs, richer generated request examples, and hosted authenticated playground behavior are outside the local rendering bridge.
- [x] [partial] `asyncapi` on navigation items maps root/API/navigation spec entries, generates an index page plus channel pages from local files or URLs into `.blume/api-content`, adds generated sidebar refs, resolves common local channel/message/schema `$ref`s, renders operations plus message payload fields, expands nested object fields, array item fields, `allOf`, and `oneOf`/`anyOf` option fields, and appends generated channel docs for manual `asyncapi` frontmatter pages. WebSocket playground behavior and exact Mintlify tabbed/expandable schema UI remain partial.
- [x] [out-of-scope] Mintlify auth, hosted assistant, integrations, agent feedback, analytics, and deployment-only settings are accepted only when ignored by passthrough schema; they do not implement behavior. This is a documented hosted/dashboard gap rather than the next implementation target.

## MDX component audit

| Mintlify surface | Status | Blume mapping | Notes |
| --- | --- | --- | --- |
| `Accordion` | `[partial]` | `Accordion.astro` | Renders title, description, icon, id, and `defaultOpen`; opening an accordion updates the URL hash, and matching hashes open the accordion on load/hashchange. Exact animation and grouped styling are not Mintlify-identical. |
| `AccordionGroup` | `[partial]` | wrapper | Groups children visually; no group-level behavior beyond native details. |
| `Badge` | `[partial]` | `Badge.astro` | Supports variants, `color`, `tooltip`, `icon`, `iconType`, `size`, `shape`, `stroke`, `disabled`, URL/path icons, and documented static `icon={<svg ... />}` props; exact Mintlify color/theme semantics are not complete. |
| `Banner` component | `[partial]` | `Banner.astro` | MDX usage renders with `title`, `type`, `color`, and `dismissible` persistence; global `docs.json` banner renders separately. Exact Mintlify styling and page-top placement semantics are not identical. |
| `Callout`, `Note`, `Info`, `Tip`, `Warning`, `Check`, `Danger` | `[partial]` | native plus aliases | Typed callouts render; custom `icon`, `iconType`, and `color` are supported for Blume's built-in icon aliases, URL/path images, common Font Awesome/Lucide/Tabler names, and documented static `icon={<svg ... />}` props. Full icon libraries and exact custom SVG parity are still incomplete. |
| `Card` | `[partial]` | `Card.astro` | Supports `title`, `href`, `icon`, `iconType`, `img`, `horizontal`, `cta`, `arrow`, `type`, and `color`; typed cards render callout-style backgrounds, borders, and default icons. Full icon-library coverage and exact Mintlify styling are not complete. |
| `CardGroup` | `[pass]` | `CardGroup.astro` | Existing Blume component covers the common grid shape. |
| `CodeGroup` | `[partial]` | wrapper plus MDX transform | Mintlify's raw titled fenced code blocks inside `CodeGroup` become tab panels; `dropdown` rendering and matching-label synchronization with other tabs/code groups work. Exact styling and full keyboard behavior are not Mintlify-identical. |
| `Color`, `Color.Item`, `Color.Row` | `[partial]` | new namespace mapping | Dotted MDX syntax should compile, render swatches, and copy values to the clipboard. Full theme-aware behavior is still incomplete. |
| `Columns`, `Column` | `[pass]` | wrappers to grid | Common `cols` layout works. |
| `Expandable` | `[partial]` | wrapper to `Accordion` | Renders collapsed content; API schema affordances are not equivalent. |
| `Frame` | `[partial]` | frame wrapper | Renders a border shell with `hint` and Markdown `caption`; autoplay videos receive `playsInline`, `loop`, and `muted` on connect. Current documented behavior is covered; exact Mintlify visual styling remains partial. |
| `Icon` | `[partial]` | `Icon.astro` | Supports `icon`/`name`, `iconType`, `size`, `color`, `className`, URL/path images, common Font Awesome/Lucide/Tabler aliases, raw SVG strings generated from documented static `icon={<svg ... />}` props, and a curated inline icon set; complete Font Awesome/Tabler libraries and dynamic SVG expressions are missing. |
| Mermaid code fences | `[partial]` | MDX transform plus `Mermaid.astro` | Fenced `mermaid` blocks render as diagrams with `actions` and `placement` props; controls are basic and not Mintlify-identical. |
| `Panel` | `[partial]` | right-rail item with inline fallback | Moves to the desktop right rail and hides inline original at `xl`; replaces TOC when present. Exact spacing and no-JS desktop behavior are not Mintlify-identical. |
| `Prompt` | `[partial]` | prompt card wrapper | Renders Markdown in `description`, prompt content, `icon`, `iconType`, `actions={["copy", "cursor"]}`, copy-to-clipboard, and Cursor deeplinks. Exact styling and full icon-library semantics are not Mintlify-identical. |
| `RequestExample`, `ResponseExample` | `[partial]` | right-rail items with inline fallback | Move to the desktop right rail and remain inline on mobile/no-JS. Raw titled code fences become switchable tabs, and `dropdown` renders a select. Exact panel styling is still not Mintlify-identical. |
| `ParamField` | `[partial]` | field card plus manual API source rewrite | Supports `name`, `path`, `query`, `body`, `header`, `type`, `required`, `deprecated`, `default`, and `placeholder`. On pages with `api` frontmatter, documented literal `ParamField` props remain visible alongside the generated endpoint bar. Dynamic JSX props and playground field UI are outside the local rendering bridge. |
| `ResponseField` | `[partial]` | field card | Supports `name`, `type`, `required`, `deprecated`, `default`, `pre`, and `post`; layout is not Mintlify-identical. |
| `Steps`, `Step` | `[partial]` | native components | Common step-by-step content works, including documented `titleSize` on `Steps` and `icon`/`iconType` on `Step`; exact Mintlify timeline styling remains partial. |
| `Tabs`, `Tab` | `[partial]` | native components | Supports `title`, `id`, `icon`/`iconType` for built-in aliases, common Font Awesome/Lucide/Tabler names, URL/path icons, `defaultTabIndex`, `sync={false}`, `borderBottom`, matching-label synchronization, hash activation, hash updates on selection, and arrow/Home/End keyboard switching. Exact styling, dropdown icon display, and full icon-library rendering are not Mintlify-identical. |
| `Tile` | `[partial]` | tile wrapper | Renders clickable visual previews with a patterned preview background and light/dark image fixture coverage. Exact Mintlify spacing and pattern styling are not complete. |
| `Tooltip` | `[partial]` | rich inline tooltip | Supports `tip`, `headline`, `cta`, and `href` with hover/focus display; exact positioning, animation, and styling are not Mintlify-identical. |
| `Tree`, `Tree.Folder`, `Tree.File` | `[partial]` | new namespace mapping | Dotted MDX syntax compiles and renders; `defaultOpen`, `openable={false}`, roving focus, arrow/Home/End navigation, Enter/Space toggles, `*` sibling expansion, and type-ahead search work in browser coverage. Exact Mintlify styling remains partial. |
| `Update` | `[partial]` | structured update row plus generated RSS | Supports `label`, `description`, `tags`, and `rss` metadata in rendered markup. Pages with `Update` components generate route-local `rss.xml` feeds, and `rss: true` frontmatter adds an alternate feed link plus header RSS action. Exact Mintlify RSS channel metadata and changelog styling remain partial. |
| `View` | `[partial]` | view panels plus page-level selector | Only the selected view is visible and selection persists in local storage. Desktop renders the selector in the right rail with a mobile inline fallback, and TOC entries filter to headings inside the selected view. Exact Mintlify dropdown styling remains partial. |
| `Visibility` | `[partial]` | web rendering plus native Blume Markdown export handling | `for="agents"` is hidden on web; `for="humans"`/`for="web"` is visible on web. Blume's native Markdown export handling remains available when explicitly enabled, but Mintlify AI/agent-output parity is not part of the dependency-swap bridge. |

## Adjacent content features

- [x] [pass] Standard Markdown, MDX JSX, code fences, lists, tables, and raw images build through Astro/MDX.
- [x] [pass] Static files under Mintlify-style root asset directories are copied for docs.json projects.
- [x] [pass] `className` on raw HTML in MDX has fixture coverage and builds.
- [x] [pass] Reusable snippets with Mintlify root-absolute `.mdx`, `.md`, and `.jsx` imports build; Markdown snippets are source-inlined before MDX compilation; nested Markdown snippets, paired/self-closing invocations, clear cycle diagnostics, and shorthand prop interpolation such as `{word}` work in prose and fenced code blocks; named static string imports from `.mdx` snippets render and are resolved for search text; files under `/snippets/` do not become standalone pages.
- [x] [pass] Global `{{variableName}}` replacements from `docs.json.variables` work in rendered source and search text without colliding with single-brace snippet props.
- [x] [partial] Personalized MDX content can reference Mintlify's `user` variable with the documented logged-out empty object fallback, so expressions such as `{user.firstName ?? "developer"}` build and render. Authenticated user data, hosted group-gated page access, schema-property filtering, and API playground prefills are not implemented.
- [x] [out-of-scope] Mintlify Markdown/AI/agent outputs are not part of local run compatibility. Blume's native `.md`, `/llms.txt`, `/llms-full.txt`, `skill.md`, and related discovery artifacts remain explicit Blume features and are not auto-enabled just because a project is loaded from `docs.json`.

## Next checks

- [x] Add a component-smoke fixture that imports every Mintlify component exactly as documented and builds with `blume`.
- [x] Fix root-content dev mode so Astro does not treat generated `.blume/.astro` files as content.
- [x] Add assertions for namespace syntax: `<Color.Item>` and `<Tree.Folder>`.
- [x] Add a transform or runtime behavior for `CodeGroup` wrapping raw fenced code blocks.
- [x] Add `CodeGroup dropdown` rendering and matching-label synchronization with tabs/code groups.
- [x] Add Mermaid rendering for fenced `mermaid` code blocks.
- [x] Add layout extraction for `Panel`, `RequestExample`, and `ResponseExample`.
- [x] Add global `docs.json.banner` rendering with dismiss persistence.
- [x] Add MDX `Banner` rendering with custom colors and dismiss persistence.
- [x] Add fixture coverage for the remaining root `docs.json` navigation modes.
- [x] Add basic switcher/dropdown UI for Mintlify tab menus, dropdowns, products, versions, and languages.
- [x] Add active-sidebar filtering for Mintlify root tabs, tab menus, dropdowns, products, versions, and languages.
- [x] Add language-specific banner, footer, and navbar chrome overrides.
- [x] Add deeply nested mixed-mode navigation behavior.
- [x] Add Mintlify nested navigation `expanded` behavior.
- [x] Add sidebar page/group icon and tag rendering.
- [x] Add clickable Mintlify group `root` page behavior.
- [x] Add Mintlify `directory` listings for group root pages.
- [x] Add documented static SVG icon prop support for `Badge`, `Callout`, and `Icon`.
- [x] Add OpenAPI fixture coverage and generate API pages for the common `docs.json` navigation shape.
- [x] Add generated OpenAPI sidebar method badges and cURL request example panels.
- [x] Prune direct-browser API playground forms from the Mintlify bridge.
- [x] Prune proxy-backed API playground execution and generated playground auth inputs from the Mintlify bridge.
- [x] Add OpenAPI `x-mint.content` and `x-mint.href` support for generated endpoint pages.
- [x] Add OpenAPI parameter pills from `x-mint.pre`, `x-mint.post`, built-ins, and `api.params.post`.
- [x] Add OpenAPI tag grouping with `x-group` display labels and tag-name URL segments.
- [x] Add nested OpenAPI request/response schema field rendering for local `$ref`, `allOf`, object, and array schemas.
- [x] Add manual Mintlify `openapi` endpoint page rendering after custom MDX content.
- [x] Add manual Mintlify `openapi-schema` page rendering from OpenAPI `components.schemas`.
- [x] Add manual Mintlify `webhook` page rendering and generated OpenAPI callback sections.
- [x] Render manual Mintlify `api` frontmatter pages as static endpoint docs while preserving documented `ParamField` props in page content.
- [x] Add page-mode fixture coverage and layout behavior for `default`, `wide`, `custom`, `frame`, and `center`.
- [x] Add reusable snippet fixture coverage for root-absolute `.mdx`/`.jsx` imports and named MDX variable imports.
- [x] Add reusable snippet fixture coverage for `.md` imports, nested imports, and Mintlify shorthand prop interpolation.
- [x] Add reusable snippet coverage for non-self-closing invocations and clearer cycle diagnostics.
- [x] Add `docs.json.variables` replacement for `{{variableName}}`.
- [x] Add AsyncAPI fixture coverage and decide whether Blume should generate pages or degrade gracefully with diagnostics.
- [x] Add manual Mintlify `asyncapi` channel page rendering after custom MDX content.
- [x] Add AsyncAPI nested array and `oneOf`/`anyOf` schema field expansion.
- [x] Keep Blume-native Markdown/AI export features explicit rather than auto-enabling them for `docs.json` compatibility.
- [x] Add logged-out `user` variable support for personalized MDX expressions.
- [x] Add group-aware public Markdown exports.
- [x] Add Mintlify `styling.latex` mapping to existing Blume math support.
- [x] Add mobile drawer chrome links and fix drawer open/close behavior.
- [x] Allow KaTeX package assets in generated dev config when Mintlify `styling.latex` enables math rendering.
- [x] Add page-level Mintlify SEO/custom meta frontmatter rendering.
- [x] Add Mintlify `hidden`, `noindex`, `deprecated`, `hideApiMarker`, `x-hidden`, and `x-excluded` visibility metadata behavior.
- [x] Add `mint` CLI alias coverage for dependency-swapped package scripts.
- [ ] Keep fully authenticated/per-user Markdown exports, hosted auth enforcement, live playground execution, and Mintlify quality commands documented as hosted/platform gaps.
