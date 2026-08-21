---
"blume": minor
---

Add a built-in `obsidian` content source. Point it at an Obsidian vault and Blume reads the notes in place — no export step, and nothing generated into your repo:

```ts
export default defineConfig({
  content: {
    sources: [{ type: "obsidian", vault: "vault", prefix: "notes" }],
  },
});
```

Wikilinks are addressed by note name across the whole vault rather than by path, the way Obsidian addresses notes — including custom link text (`[[Note|label]]`), heading anchors (`[[Note#Install]]`), full paths (`[[folder/Note]]`), and the partial paths Obsidian's "shortest path when possible" setting writes (`[[guides/Note]]`). A name claimed by two notes resolves to a note whose full vault path is exactly that name, then to the first in vault order, and warns. Obsidian's own default properties (`tags`, `aliases`, `cssclasses`, and their legacy singular spellings) are dropped when a note is lowered, so a vault written with the Properties UI builds cleanly; `aliases` is dropped rather than resolved, since alias link targets are not supported yet. Heading anchors resolve against the target note's real headings, including `[[#Install]]` for a heading in the note you are writing; a block reference (`[[Note#^id]]`) links to its note without an anchor. A heading that itself contains Markdown is the exception: Blume's manifest anchor and rendered id differ for those, so a link to one may land on the page rather than the section. The source does not support i18n or versioned-content routing yet — both transformations happen during normalization, after wikilinks have been rewritten. A wikilink to a missing note degrades to plain text, and one to a missing heading keeps the page link without the anchor — both warn instead of failing the build. Single-line `%%comments%%` are stripped, a note with no frontmatter `title` is titled by its filename (except an `index` note, which falls through to Blume's usual title derivation), and fenced, indented, and inline code passes through verbatim. Relative images beside a note are served from the vault, a vault inside the git repository gets git-derived "Last updated" dates, and "Edit this page" links appear for vaults inside the project root. Dot-folders are skipped, and the dev watcher ignores Obsidian's own `.obsidian` directory so moving a pane in the app doesn't rebuild the site.

`blume init` can scaffold the source (seeding a starter `vault/`), and callouts, embeds, multi-line comments, and backlinks are not lowered yet.
