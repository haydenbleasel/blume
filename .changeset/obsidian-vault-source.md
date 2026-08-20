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

Wikilinks are addressed by note name across the whole vault rather than by path, the way Obsidian addresses notes — including custom link text (`[[Note|label]]`), heading anchors (`[[Note#Install]]`), and full paths (`[[folder/Note]]`). A name claimed by two notes resolves to the first in vault order and warns. Obsidian's `aliases` frontmatter property is not resolved yet. Heading anchors resolve against the target note's real headings, including `[[#Install]]` for a heading in the note you are writing. A heading that itself contains Markdown is the exception: Blume's manifest anchor and rendered id differ for those, so a link to one may land on the page rather than the section. The source does not support i18n or versioned-content routing yet — both transformations happen during normalization, after wikilinks have been rewritten. A wikilink to a missing note degrades to plain text, and one to a missing heading keeps the page link without the anchor — both warn instead of failing the build. Single-line `%%comments%%` are stripped, a note with no frontmatter `title` is titled by its filename (except an `index` note, which falls through to Blume's usual title derivation), and code fences and inline code spans pass through verbatim. Dot-folders are skipped, and the dev watcher ignores Obsidian's own `.obsidian` directory so moving a pane in the app doesn't rebuild the site.

`blume init` can scaffold the source, and callouts, embeds, multi-line comments, and backlinks are not lowered yet.
