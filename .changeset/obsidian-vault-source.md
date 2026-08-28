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

- `[[Wikilinks]]` become route links, addressed by note name across the whole vault the way Obsidian addresses notes: custom link text (`[[Note|label]]`, and `[[Note\|label]]` inside a table), heading anchors (`[[Note#Install]]`, `[[#Install]]`), block references (`[[Note#^id]]`), full and partial paths (`[[folder/Note]]`, `[[Note.md]]`), and a frontmatter `slug`. A name two notes share resolves to an exact path match first, then to the first note in vault order, and warns only when a link actually resolves through the collision.
- Heading anchors resolve against the target note's real headings, matched the way Obsidian writes them (inline formatting stripped) and slugged by the same pass that fills the page manifest.
- Frontmatter keeps Blume's page meta plus any key declared in `frontmatter.extend` or, for notes of that type, in a content type's `frontmatter`; every other Obsidian property (including `tags`, `aliases`, and `cssclasses`) is dropped, so a vault written with the Properties UI builds cleanly.
- Locale directories and version snapshots inside the vault publish under their locale and version like filesystem content.
- An unresolved wikilink degrades to plain text with a warning, and one to a missing heading keeps the page link; single-line `%%comments%%` are stripped and a wikilink inside an HTML comment is left alone; fenced, indented, and inline code pass through verbatim; symlinked folders are followed; untitled notes take their filename as the title; dot-folders (`.obsidian`, `.trash`, plugin caches) and the usual never-content directories are skipped by both the scan and the dev watcher; `blume version cut` leaves a vault inside `content.root` out of the snapshot.
- Vault notes get git "Last updated" dates when the vault is inside the repository, and "Edit this page" links through `github.dir` for a vault beside a monorepo docs app.

`blume init` offers the source and seeds a first note. Not yet lowered: callouts, embeds, multi-line comments, aliases as link targets, and backlinks.

Also in this release: `frontmatter`'s `stringify` no longer re-parses a string body (a body opening with a `---` divider was read as a second front matter block), and git last-modified dating now skips the scan entirely when no local source exposes a content root — a custom staged source that sets `sourcePath` without a `contentRoot` is no longer dated — set `contentRoot` on the source to date its pages.
