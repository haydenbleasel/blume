---
"blume": minor
---

Custom `.astro` pages now reach agents the way content pages do. After the build writes the HTML, Blume reads each static custom page back and converts what it renders inside `<main>` to Markdown. The Markdown is served at the page's `.md` and `.mdx` URLs and answers `Accept: text/markdown` on Vercel and Cloudflare server builds. The page is listed in `llms.txt` under the header tab whose section it sits in (or under a new **Pages** section), and its Markdown is included in `llms-full.txt`. `PageLayout` advertises the copy as a `text/markdown` alternate. The homepage keeps the `llms.txt` index as its mirror.

Elements that only CSS spaces apart are separated by a space, because the built HTML has no whitespace between tags. Text next to an element, and anything inside `pre` or `code`, keeps its spacing exactly. Scripts, styles, inline SVG, form controls, navigation, decorative images and anything hidden from readers are left out of the Markdown. Mark anything else web-only with `data-blume-visibility="web"`, the attribute `<Visibility for="web">` renders, and set it to `"agents"` to keep a hidden element. `PageLayout`'s new `ai={{ exclude: true }}` keeps a whole page off the agent surfaces, as front matter `ai.exclude` does for a content page. A page's `llms.txt` line takes its `<title>` without a trailing segment that names the site.

The sitemap now dates custom pages and the generated changelog index from the `dateModified` in their JSON-LD (or their `article:modified_time`), and leaves out a custom page whose robots meta says `noindex`.
