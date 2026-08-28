import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";
import { z } from "zod";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { obsidianSource } from "../src/core/sources/obsidian.ts";
import type { ObsidianSourceOptions } from "../src/core/sources/obsidian.ts";
import { resolveSources } from "../src/core/sources/resolve.ts";
import type { SourceContext } from "../src/core/sources/types.ts";
import type { ProjectContext } from "../src/core/types.ts";

const dirs: string[] = [];

/** Write a vault to a temp dir; keys are vault-relative paths. */
const makeVault = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-obsidian-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    })
  );
  return root;
};

const context = (projectRoot: string): SourceContext => ({
  cacheDir: join(projectRoot, ".blume", "cache", "obsidian"),
  mode: "build",
  projectRoot,
});

/** A source rooted at `projectRoot`, reading the vault dir `vault`. */
const sourceFor = (
  projectRoot: string,
  options: Omit<Partial<ObsidianSourceOptions>, "name"> = {}
) =>
  obsidianSource(
    { ...options, name: "obsidian", vault: options.vault ?? "." },
    context(projectRoot)
  );

const lines = (...parts: string[]): string => parts.join("\n");

/** A vault exercising every dialect feature the source lowers. */
const BASIC = {
  ".obsidian/workspace.json": '{"main":{}}',
  "Index.md": lines(
    "---",
    "description: The vault entry point.",
    "---",
    "",
    "A plain link to [[Getting Started]].",
    "An alias link to [[Getting Started|the install steps]].",
    "An anchor link to [[Getting Started#Install]].",
    "A path link to [[guides/Getting Started]].",
    "A link to [[A Missing Note]] should survive as text.",
    "An embed ![[diagram.png]] stays untouched.",
    "%%an editor note%% is dropped.",
    "",
    "Inline code like `[[Getting Started]]` must stay verbatim.",
    "",
    "```md",
    "Inside a fence, [[Getting Started]] must stay verbatim.",
    "```",
    ""
  ),
  "guides/Getting Started.md": lines(
    "---",
    "title: Getting started",
    "---",
    "",
    "## Install",
    "",
    "Back to [[Index]].",
    ""
  ),
  "guides/assets/notes.txt": "not markdown",
};

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describe("obsidianSource", () => {
  it("loads every note in the vault, skipping dot-dirs and non-markdown", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    // Folders list before notes, the way Obsidian's explorer orders a vault.
    expect(entries.map((entry) => entry.ref)).toEqual([
      "guides/Getting Started.md",
      "Index.md",
    ]);
  });

  it("skips excluded top-level folders", async () => {
    const root = await makeVault({
      ...BASIC,
      "Templates/Daily.md": "# Daily",
    });
    const { entries } = await sourceFor(root, {
      exclude: ["Templates"],
    }).load();
    expect(entries.map((entry) => entry.ref)).not.toContain(
      "Templates/Daily.md"
    );
  });

  it("rewrites a wikilink to the target note's route", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "A plain link to [Getting Started](/guides/getting-started)."
    );
  });

  it("uses the alias as the link label", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "[the install steps](/guides/getting-started)"
    );
  });

  it("appends a heading anchor and labels the link with the heading", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "[Install](/guides/getting-started#install)"
    );
  });

  it("matches an NFD filename against the NFC wikilink an editor types", async () => {
    const root = await makeVault({
      "Links.md": "See [[Café]].\n".normalize("NFC"),
      // macOS stores this filename decomposed; Obsidian types it composed.
      ["Café.md".normalize("NFD")]: "# Cafe\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("(/café)");
    expect(diagnostics).toEqual([]);
  });

  it("leaves a wikilink inside a multi-backtick code span verbatim", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": "Escaped: ``a ` [[Notes]] b`` end.\n",
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // A span opened with `` closes on the next ``, not on the single ` inside
    // it — so the wikilink between them is code, not a link.
    expect(sample?.body.text).toContain("``a ` [[Notes]] b``");
  });

  it("leaves a wikilink inside a code span that spans lines", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": "Start `code\n[[Notes]]\nafter` end.\n",
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // CommonMark lets a span hold newlines, so the scan runs over a whole run
    // of prose rather than one line at a time.
    expect(sample?.body.text).toContain("`code\n[[Notes]]\nafter`");
  });

  it("resolves a heading link with no note target against the current note", async () => {
    const root = await makeVault({
      "Page.md": "## Install\n\nSee [[#Install]].\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    expect(entries[0]?.body.text).toContain("[Install](/page#install)");
    expect(diagnostics).toEqual([]);
  });

  it("warns when a same-note heading link names no heading", async () => {
    const root = await makeVault({
      "Page.md": "## Install\n\nSee [[#Nowhere]].\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    // The same rule as a missing heading in another note: the page link
    // survives, only the anchor is dropped.
    expect(entries[0]?.body.text).toContain("See [Nowhere](/page).");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("#Nowhere");
  });

  it("leaves an empty wikilink alone — it targets nothing", async () => {
    const root = await makeVault({ "Page.md": "Not a link: [[]].\n" });
    const { entries, diagnostics } = await sourceFor(root).load();
    expect(entries[0]?.body.text).toContain("[[]]");
    expect(diagnostics).toEqual([]);
  });

  it("rewrites a wikilink after an unpaired backtick", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": "A ` stray backtick before [[Notes]].\n",
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // An unclosed run opens no span, so what follows is ordinary text.
    expect(sample?.body.text).toContain("before [Notes](/notes).");
  });

  it("indexes a heading by the text it renders as, not the text as authored", async () => {
    const root = await makeVault({
      "Links.md": "See [[Page#Setup]].\n",
      "Page.md": "## Setup %%revisit this%%\n\nText.\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // The comment is stripped before Blume scans headings, so the shipped
    // heading is `Setup` — indexing the authored text would slug `setup-revisit-this`.
    expect(links?.body.text).toContain("(/page#setup)");
    expect(diagnostics).toEqual([]);
  });

  it("falls back to the file on disk by route, not by frontmatter slug", async () => {
    const root = await makeVault({
      "Links.md": "See [[Odd]].\n",
      "Odd.md": '---\nslug: "/"\n---\n\n# Odd\n',
    });
    const { entries } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // A slug that trims to nothing falls back to the path, in the pipeline and
    // here alike — `/` would otherwise claim the home page.
    expect(links?.body.text).toContain("[Odd](/Odd)");
  });

  it("skips an excluded folder at any depth, not just at the vault root", async () => {
    const root = await makeVault({
      "Index.md": "# Home\n",
      "guides/Templates/Draft.md": "# Draft\n",
    });
    const { entries } = await sourceFor(root, {
      exclude: ["Templates"],
    }).load();
    expect(entries.map((entry) => entry.ref)).toEqual(["Index.md"]);
  });

  it("skips a note that vanished between the walk and the read", async () => {
    const root = await makeVault({ "Kept.md": "# Kept\n" });
    // A broken symlink is listed by the walk and gone by the read — the same
    // window Obsidian opens every time it renames or deletes a note in dev.
    await symlink(join(root, "gone.md"), join(root, "Ghost.md"));
    const { entries } = await sourceFor(root).load();
    expect(entries.map((entry) => entry.ref)).toEqual(["Kept.md"]);
  });

  it("still fails on a read error that is not a missing file", async () => {
    const root = await makeVault({ "Kept.md": "# Kept\n" });
    // A self-referential symlink is listed by the walk and yields ELOOP, not
    // ENOENT — a real read failure the load must not swallow.
    await symlink("Loop.md", join(root, "Loop.md"));
    await expect(sourceFor(root).load()).rejects.toThrow();
  });

  it("follows a symlinked folder into the vault, like the filesystem source", async () => {
    const shared = await makeVault({ "Linked.md": "# Linked\n" });
    const root = await makeVault({ "Note.md": "See [[Linked]].\n" });
    await symlink(shared, join(root, "shared"));
    // A dangling directory link is neither a folder nor a note: skipped.
    await symlink(join(root, "gone"), join(root, "missing"));
    const { diagnostics, entries } = await sourceFor(root).load();
    const note = entries.find((entry) => entry.ref === "Note.md");
    // `Dirent.isDirectory()` is false for a symlink, which silently dropped
    // the folder and reported every link into it as a missing note.
    expect(entries.map((entry) => entry.ref)).toEqual([
      "shared/Linked.md",
      "Note.md",
    ]);
    expect(note?.body.text).toContain("See [Linked](/shared/linked).");
    expect(diagnostics).toEqual([]);
  });

  it("leaves a wikilink inside an HTML comment alone, without warning", async () => {
    const root = await makeVault({
      "Note.md": lines(
        "Visible [[Real]] and <!-- hidden [[Draft]] --> after.",
        "An unclosed <!-- opener is text, so [[Real]] still rewrites.",
        "A span `<!-- [[Real]]` is code, and [[Real]] outside it is not.",
        ""
      ),
      "Real.md": "# Real\n",
    });
    const { diagnostics, entries } = await sourceFor(root).load();
    const note = entries.find((entry) => entry.ref === "Note.md");
    // Obsidian hides the comment in reading view; a reader never sees the
    // link, so a build warning about it would name a problem that isn't one.
    expect(note?.body.text).toContain(
      "Visible [Real](/real) and <!-- hidden [[Draft]] --> after."
    );
    expect(note?.body.text).toContain(
      "An unclosed <!-- opener is text, so [Real](/real) still rewrites."
    );
    expect(note?.body.text).toContain(
      "A span `<!-- [[Real]]` is code, and [Real](/real) outside it is not."
    );
    expect(diagnostics).toEqual([]);
  });

  it("reads a bracketed wikilink as a literal bracket around the link", async () => {
    const root = await makeVault({
      "Note.md": "Compare [[[Real]]] here.\n",
      "Real.md": "# Real\n",
    });
    const { diagnostics, entries } = await sourceFor(root).load();
    const note = entries.find((entry) => entry.ref === "Note.md");
    // Obsidian renders `[`, the link, `]`; the target was read as `[Real`.
    expect(note?.body.text).toContain("Compare [[Real](/real)] here.");
    expect(diagnostics).toEqual([]);
  });

  it("honors a pinned heading id and the collision it forces", async () => {
    const root = await makeVault({
      "Note.md": lines("First [[Target#Install]], then [[Target#Setup]].", ""),
      "Target.md": lines("## Install [#setup]", "", "## Setup", ""),
    });
    const { entries } = await sourceFor(root).load();
    const note = entries.find((entry) => entry.ref === "Note.md");
    // The renderer emits `setup` for the pinned heading and `setup-1` for the
    // one whose auto-slug it displaced; re-slugging the text gave `install`
    // (an id no page emits) and `setup` (the wrong heading).
    expect(note?.body.text).toContain(
      "First [Install](/target#setup), then [Setup](/target#setup-1)."
    );
  });

  it("leaves a fence inside a list item verbatim", async () => {
    const root = await makeVault({
      "Note.md": lines(
        "1. Step one",
        "",
        "    ```js",
        '    const a = "[[Target]]"; %%todo%%',
        "",
        '    const b = "[[Target|x]]";',
        "    ```",
        "",
        "Then [[Target]].",
        ""
      ),
      "Target.md": "# Target\n",
    });
    const { entries } = await sourceFor(root).load();
    const note = entries.find((entry) => entry.ref === "Note.md");
    // The item's content indent puts the fence four spaces deep, where a
    // fence outside a list can never sit; CommonMark still reads it as fenced
    // code, so its wikilinks and comment are content.
    expect(note?.body.text).toContain('    const a = "[[Target]]"; %%todo%%');
    expect(note?.body.text).toContain('    const b = "[[Target|x]]";');
    expect(note?.body.text).toContain("Then [Target](/target).");
  });

  it("read() refuses a ref that resolves outside the vault", async () => {
    const root = await makeVault(BASIC);
    await expect(
      sourceFor(root, { vault: "guides" }).read?.("../Index.md")
    ).rejects.toThrow(/outside the vault/u);
    await expect(
      sourceFor(root, { vault: "guides" }).read?.(join(root, "Index.md"))
    ).rejects.toThrow(/outside the vault/u);
  });

  it("keeps non-Latin filenames as distinct routes instead of collapsing them", async () => {
    const root = await makeVault({
      "Café.md": "# Cafe\n",
      "Links.md": "See [[日本語]] and [[Café]].\n",
      "日本語.md": "# Japanese\n",
    });
    const { entries } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // An ASCII-only slugger empties `日本語`, which then routes to `/` and
    // collides with the home page, and it drops the accent from `Café`.
    expect(links?.body.text).toContain("(/日本語)");
    expect(links?.body.text).toContain("(/café)");
  });

  it("links to the route a frontmatter slug publishes at, not the filename", async () => {
    const root = await makeVault({
      "Custom.md": "---\nslug: renamed\n---\n\n# Custom\n",
      "Links.md": "See [[Custom]].\n",
    });
    const { entries } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("[Custom](/renamed)");
  });

  it("strips a numeric prefix from a link the same way the route does", async () => {
    const root = await makeVault({
      "01 Intro.md": "# Intro\n",
      "Links.md": "See [[01 Intro]].\n",
    });
    const { entries } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("(/intro)");
  });

  it("normalizes a prefix written with stray slashes", async () => {
    const root = await makeVault({
      "Links.md": "See [[Notes]].\n",
      "Notes.md": "# Notes\n",
    });
    const { entries } = await sourceFor(root, { prefix: "/notes/" }).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // `//notes//notes` would be read as a protocol-relative URL.
    expect(links?.body.text).toContain("[Notes](/notes/notes)");
    expect(links?.body.text).not.toContain("//notes");
  });

  it("treats a backtick fence inside a tilde fence as content", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": lines(
        "~~~md",
        "```",
        "A [[Notes]] link inside the outer fence stays verbatim.",
        "```",
        "~~~",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // A boolean toggle would close the ~~~ fence on the inner ``` line and
    // rewrite the wikilink that follows.
    expect(sample?.body.text).toContain("A [[Notes]] link inside");
  });

  it("warns when one note name is claimed by two files, and takes the first", async () => {
    const root = await makeVault({
      "Links.md": "See [[Setup]] and [[setup]].\n",
      "a/Setup.md": "# A setup\n",
      "b/Setup.md": "# B setup\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("[Setup](/a/setup)");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_WIKILINK_AMBIGUOUS");
    // Two links, one colliding name.
    expect(diagnostics[0]?.message).toContain("found 2 wikilink(s) to 1 note");
    expect(diagnostics[0]?.message).toContain("a/Setup.md");
    expect(diagnostics[0]?.message).toContain("b/Setup.md");
  });

  it("stays silent about a name collision no wikilink resolves through", async () => {
    const root = await makeVault({
      "Links.md": "See [[a/index]].\n",
      "a/index.md": "# A\n",
      "b/index.md": "# B\n",
    });
    // Two folder `index` notes are the documented route convention, not a
    // problem — only a bare `[[index]]` would have to pick one.
    const { diagnostics } = await sourceFor(root).load();
    expect(diagnostics).toEqual([]);
  });

  it("resolves an ambiguous name unambiguously through its full path", async () => {
    const root = await makeVault({
      "Links.md": "See [[guides/Setup]].\n",
      "Setup.md": "# Root setup\n",
      "guides/Setup.md": "# Guide setup\n",
    });
    const { entries } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("(/guides/setup)");
  });

  it("slugs an anchor with github-slugger, not a hand-rolled slugify", async () => {
    const root = await makeVault({
      "Links.md": "See [[Notes#The read -- write fallback]].\n",
      "Notes.md": "## The read -- write fallback\n\nText.\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // A hand slugify collapses `--` to one dash; github-slugger — the slugger
    // the renderer uses — keeps every one, so only this id exists on the page.
    expect(links?.body.text).toContain("(/notes#the-read----write-fallback)");
    expect(diagnostics).toEqual([]);
  });

  it("points a repeated-heading link at the first of the duplicates", async () => {
    const root = await makeVault({
      "Links.md": "See [[Notes#Setup]].\n",
      "Notes.md": "## Setup\n\nOne.\n\n## Setup\n\nTwo.\n",
    });
    const { entries } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // The slugger disambiguates the second one to `setup-1`; Obsidian itself
    // resolves the link to the first match.
    expect(links?.body.text).toContain("(/notes#setup)");
    expect(links?.body.text).not.toContain("setup-1");
  });

  it("keeps the page link and drops the anchor when the heading is missing", async () => {
    const root = await makeVault({
      "Links.md": "See [[Notes#Nowhere]].\n",
      "Notes.md": "## Install\n\nText.\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("[Nowhere](/notes)");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_WIKILINK_UNRESOLVED");
    expect(diagnostics[0]?.message).toContain("missing heading");
    expect(diagnostics[0]?.message).toContain("Notes#Nowhere");
  });

  it("warns separately about missing notes and missing headings", async () => {
    const root = await makeVault({
      "Links.md": "See [[Nowhere]] and [[Notes#Missing]].\n",
      "Notes.md": "## Install\n\nText.\n",
    });
    const { diagnostics } = await sourceFor(root).load();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.message).toContain("missing note");
    expect(diagnostics[1]?.message).toContain("missing heading");
  });

  it("keeps the alias as the label when a link carries both heading and alias", async () => {
    const root = await makeVault({
      "Guide.md": "## Install\n\nSteps.\n",
      "Links.md": "See [[Guide#Install|installation]].\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // The heading capture stops at `|`, so the alias is the label and the
    // anchor still resolves.
    expect(links?.body.text).toContain("[installation](/guide#install)");
    expect(diagnostics).toEqual([]);
  });

  it("resolves a vault-relative path target, not just a bare note name", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "A path link to [guides/Getting Started](/guides/getting-started)."
    );
  });

  it("links to an index note land on the folder route, not /index", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const guide = entries.find(
      (entry) => entry.ref === "guides/Getting Started.md"
    );
    expect(guide?.body.text).toContain("Back to [Index](/).");
  });

  it("namespaces rewritten links under the configured prefix", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root, { prefix: "notes" }).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "[Getting Started](/notes/guides/getting-started)"
    );
  });

  it("degrades an unresolved wikilink to plain text and warns once", async () => {
    const root = await makeVault(BASIC);
    const { entries, diagnostics } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "A link to A Missing Note should survive"
    );
    expect(index?.body.text).not.toContain("[[A Missing Note]]");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_WIKILINK_UNRESOLVED");
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.message).toContain("A Missing Note");
  });

  it("reports no diagnostics when every wikilink resolves", async () => {
    const root = await makeVault({
      "Index.md": "Back to [[Index]].\n",
    });
    const { diagnostics } = await sourceFor(root).load();
    expect(diagnostics).toEqual([]);
  });

  it("leaves embeds untouched — attachments are not served yet", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain("![[diagram.png]]");
  });

  it("strips single-line %%comments%%", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).not.toContain("an editor note");
    expect(index?.body.text).toContain(" is dropped.");
  });

  it("leaves fenced code blocks and inline code spans verbatim", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    expect(index?.body.text).toContain(
      "Inside a fence, [[Getting Started]] must stay verbatim."
    );
    expect(index?.body.text).toContain(
      "Inline code like `[[Getting Started]]` must stay verbatim."
    );
  });

  it("keeps an explicit frontmatter title and the rest of the frontmatter", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    const guide = entries.find(
      (entry) => entry.ref === "guides/Getting Started.md"
    );
    expect(index?.data.description).toBe("The vault entry point.");
    expect(guide?.data.title).toBe("Getting started");
  });

  it("titles an untitled note by its filename, Obsidian-style", async () => {
    const root = await makeVault({ "Release Notes.md": "Shipped.\n" });
    const { entries } = await sourceFor(root).load();
    expect(entries[0]?.data.title).toBe("Release Notes");
  });

  it("leaves an untitled index note to Blume's own title derivation", async () => {
    const root = await makeVault({ "index.md": "# Home\n\nWelcome.\n" });
    const { entries } = await sourceFor(root).load();
    // `index` names a route, not a note: titling the page "index" would beat
    // Blume's first-heading fallback with a worse answer.
    expect(entries[0]?.data.title).toBeUndefined();
  });

  it("still honors an explicit title on an index note", async () => {
    const root = await makeVault({
      "Index.md": "---\ntitle: Home\n---\n\nWelcome.\n",
    });
    const { entries } = await sourceFor(root).load();
    expect(entries[0]?.data.title).toBe("Home");
  });

  it("stages entries with raw frontmatter, a hash, and the note's path", async () => {
    const root = await makeVault(BASIC);
    const source = sourceFor(root);
    const { entries } = await source.load();
    expect(source.staged).toBe(true);
    for (const entry of entries) {
      expect(entry.raw).toStartWith("---");
      expect(entry.hash).toBeTruthy();
      expect(entry.sourcePath).toBe(join(root, entry.ref));
    }
  });

  it("slugs a root index note to `index` so route derivation places it", async () => {
    const root = await makeVault(BASIC);
    const { entries } = await sourceFor(root).load();
    const index = entries.find((entry) => entry.ref === "Index.md");
    const guide = entries.find(
      (entry) => entry.ref === "guides/Getting Started.md"
    );
    expect(index?.slug).toBe("index");
    expect(guide?.slug).toBe("guides/getting-started");
  });

  it("read() serves the note as written, before and after a load", async () => {
    const root = await makeVault(BASIC);
    const source = sourceFor(root);
    await source.load();
    const raw = await source.read?.("guides/Getting Started.md");
    // The lowered body is what `load` stages; the lazy read is the file
    // itself, like the filesystem source, with no second copy held in memory.
    expect(raw).toContain("title: Getting started");
    expect(raw).toContain("Back to [[Index]].");
  });

  it("read() falls back to the file on disk before any load", async () => {
    const root = await makeVault(BASIC);
    const raw = await sourceFor(root).read?.("guides/Getting Started.md");
    expect(raw).toContain("Back to [[Index]].");
  });

  it("validate() passes for a vault that exists", async () => {
    const root = await makeVault(BASIC);
    expect(() => sourceFor(root).validate?.()).not.toThrow();
  });

  it("validate() rejects a vault path that names a file", async () => {
    const root = await makeVault({ "notes.md": "# A file\n" });
    // `existsSync` is true for a regular file; without a directory check the
    // failure surfaces later as a raw ENOTDIR from the walk.
    expect(() => sourceFor(root, { vault: "notes.md" }).validate?.()).toThrow(
      /is not a directory/u
    );
  });

  it("validate() throws a pointed error naming the vault option", async () => {
    const root = await makeVault(BASIC);
    expect(() =>
      sourceFor(root, { vault: "not-a-vault" }).validate?.()
    ).toThrow(/does not exist/u);
  });

  it("watch() returns a disposer that closes the watcher", async () => {
    const root = await makeVault(BASIC);
    // Lifecycle only: that the listener ignores `.obsidian` and Blume's own
    // output dirs is a property of the shared `ignoringWatchListener`, covered
    // by sources-watch.test.ts. Asserting a real fs.watch event here would be
    // timing-dependent.
    const stop = sourceFor(root).watch?.(() => {
      // Never invoked; no note is edited in this test.
    });
    expect(stop).toBeTypeOf("function");
    stop?.();
  });

  it("watch() on a missing vault is a no-op disposer", async () => {
    const root = await makeVault(BASIC);
    const stop = sourceFor(root, { vault: "not-a-vault" }).watch?.(() => {
      // Never invoked; the vault does not exist.
    });
    expect(() => stop?.()).not.toThrow();
  });

  it("drops Obsidian's own default properties from the frontmatter", async () => {
    const root = await makeVault({
      "Note.md": lines(
        "---",
        "tags: [project]",
        "aliases: [Setup]",
        "cssclasses: [wide]",
        "tag: legacy",
        "alias: Old",
        "cssclass: narrow",
        "description: Kept.",
        "---",
        "",
        "Body.",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    // Obsidian's Properties UI writes these by default; the strict Blume meta
    // schema would reject them and fail the build for any realistic vault.
    expect(entries[0]?.data).toEqual({ description: "Kept.", title: "Note" });
    expect(entries[0]?.raw).not.toContain("tags:");
    expect(entries[0]?.raw).toContain("description: Kept.");
  });

  it("resolves a partial-path link, the shortest-path form Obsidian writes", async () => {
    const root = await makeVault({
      "Links.md": "See [[guides/Setup]].\n",
      "docs/guides/Setup.md": "# Guide setup\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // Obsidian's default "shortest path when possible" setting auto-writes
    // this form; indexing only basenames and full paths would miss it.
    expect(links?.body.text).toContain("(/docs/guides/setup)");
    expect(diagnostics).toEqual([]);
  });

  it("resolves a shared partial path to the first in vault order, silently", async () => {
    const root = await makeVault({
      "Links.md": "See [[notes/Intro]].\n",
      "a/notes/Intro.md": "# A\n",
      "b/notes/Intro.md": "# B\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("(/a/notes/intro)");
    // A longer shared suffix is already the author's disambiguation, and the
    // bare `intro` collision is never linked, so nothing warns.
    expect(diagnostics).toEqual([]);
  });

  it("prefers an exact path match over vault order for a shared name", async () => {
    const root = await makeVault({
      "Guides/Setup.md": "# Guide setup\n",
      "Links.md": "See [[Setup]].\n",
      "setup.md": "# Root setup\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // `Guides/Setup.md` sorts first, but the root note's full vault path is
    // exactly `setup` — Obsidian resolves a link as a path before a name, so
    // the link is not ambiguous and nothing warns.
    expect(links?.body.text).toContain("[Setup](/setup)");
    expect(diagnostics).toEqual([]);
  });

  it("links a block reference to its note without an anchor or warning", async () => {
    const root = await makeVault({
      "Links.md": "See [[Other#^a1b2c3]] and [[Other#^a1b2c3|the summary]].\n",
      "Other.md": "Some text. ^a1b2c3\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // Blocks render with no anchor to land on; the note link beats a spurious
    // missing-heading warning, and the generated id never labels the link.
    expect(links?.body.text).toContain("[Other](/other)");
    expect(links?.body.text).toContain("[the summary](/other)");
    expect(diagnostics).toEqual([]);
  });

  it("links a same-note block reference to the note itself", async () => {
    const root = await makeVault({
      "Page.md":
        "A key point. ^point\n\nSee [[#^point]] and [[#^point|that point]].\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    // The caret never reaches the label — `[^point]` would read as a GFM
    // footnote reference.
    expect(entries[0]?.body.text).toContain("[point](/page)");
    expect(entries[0]?.body.text).toContain("[that point](/page)");
    expect(diagnostics).toEqual([]);
  });

  it("does not pair stray backticks across a blank line", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": lines(
        "A stray ` backtick.",
        "",
        "A real link to [[Notes]].",
        "",
        "Another stray ` later.",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // A code span cannot cross a blank line (CommonMark 6.1); pairing these
    // backticks would swallow the whole paragraph between them.
    expect(sample?.body.text).toContain("[Notes](/notes)");
  });

  it("leaves an indented code block verbatim", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": lines(
        "Prose first.",
        "",
        "    See [[Notes]] and %%hidden%% here",
        "",
        "\tstill code [[Notes]]",
        "",
        "Prose again: [[Notes]].",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // Four spaces or a tab open an indented code block after a blank line, and
    // blank lines inside it keep it open — the sample must ship untouched.
    expect(sample?.body.text).toContain(
      "    See [[Notes]] and %%hidden%% here"
    );
    expect(sample?.body.text).toContain("\tstill code [[Notes]]");
    expect(sample?.body.text).toContain("Prose again: [Notes](/notes).");
  });

  it("does not let an indented fence marker toggle the fence state", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": lines("Prose.", "", "    ```", "", "After: [[Notes]].", ""),
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // A fence can be indented at most three spaces (CommonMark 4.5); four is
    // an indented code block, and reading it as a fence would leave the rest
    // of the note un-rewritten.
    expect(sample?.body.text).toContain("After: [Notes](/notes).");
  });

  it("keeps an indented continuation line inside a paragraph as prose", async () => {
    const root = await makeVault({
      "Notes.md": "# Notes\n",
      "Sample.md": lines(
        "A paragraph line",
        "    continued with [[Notes]].",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const sample = entries.find((entry) => entry.ref === "Sample.md");
    // An indented code block cannot interrupt a paragraph (CommonMark 4.4);
    // this is a continuation line and its link must still rewrite.
    expect(sample?.body.text).toContain("continued with [Notes](/notes).");
  });

  it("exposes the vault as its content root for git last-modified", async () => {
    const root = await makeVault(BASIC);
    const source = sourceFor(root);
    // Folder-meta discovery still skips it — that scan is guarded on `staged`.
    expect(source.contentRoot).toBe(root);
  });

  it("lists folders before notes, case-insensitively and numerically", async () => {
    const root = await makeVault({
      "Note 10.md": "# Ten\n",
      "Note 2.md": "# Two\n",
      "alpha.md": "# Alpha\n",
      "zed/Inner.md": "# Inner\n",
    });
    const { entries } = await sourceFor(root).load();
    // Obsidian's explorer order: subfolders first, then `Note 2` before
    // `Note 10`, with `alpha` sorting by letter rather than by case.
    expect(entries.map((entry) => entry.ref)).toEqual([
      "zed/Inner.md",
      "alpha.md",
      "Note 2.md",
      "Note 10.md",
    ]);
  });

  it("skips the never-content directories every filesystem scan skips", async () => {
    const root = await makeVault({
      "Note.md": "# Note\n",
      "dist/out.md": "# Built\n",
      "node_modules/pkg/README.md": "# Dep\n",
    });
    // A vault rooted at the project must not publish dependency READMEs, and
    // the scan must agree with the watcher about what is content.
    const { entries } = await sourceFor(root).load();
    expect(entries.map((entry) => entry.ref)).toEqual(["Note.md"]);
  });

  it("resolves the `[[Note.md]]` path form Obsidian also accepts", async () => {
    const root = await makeVault({
      "Links.md": "See [[Other.md]] and [[Other.md#Part]].\n",
      "Other.md": "## Part\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("[Other.md](/other)");
    expect(links?.body.text).toContain("[Part](/other#part)");
    expect(diagnostics).toEqual([]);
  });

  it("reads the escaped pipe Obsidian writes for an alias inside a table", async () => {
    const root = await makeVault({
      "Links.md": lines(
        "| Note | Section |",
        "| --- | --- |",
        "| [[Other\\|the other]] | [[Other#Part\\|its part]] |",
        ""
      ),
      "Other.md": "## Part\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("| [the other](/other) |");
    expect(links?.body.text).toContain("| [its part](/other#part) |");
    expect(diagnostics).toEqual([]);
  });

  it("matches a heading link the way Obsidian writes it, formatting stripped", async () => {
    const root = await makeVault({
      "Links.md": lines(
        "See [[Other#Bold heading]], [[Other#**Bold** heading]],",
        "[[Other#Read the docs now]], [[Other#Use snake_case]].",
        ""
      ),
      "Other.md": lines(
        "## **Bold** heading",
        "",
        "## Read [the docs](/docs) `now`",
        "",
        "## Use _snake_case_",
        ""
      ),
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    // Obsidian's autocomplete drops emphasis, code, and link syntax from the
    // heading text — and that text is what the rendered id is slugged from.
    expect(links?.body.text).toContain("[Bold heading](/other#bold-heading)");
    expect(links?.body.text).toContain(
      "[**Bold** heading](/other#bold-heading)"
    );
    expect(links?.body.text).toContain(
      "[Read the docs now](/other#read-the-docsdocs-now)"
    );
    expect(links?.body.text).toContain(
      "[Use snake_case](/other#use-_snake_case_)"
    );
    expect(diagnostics).toEqual([]);
  });

  it("rewrites a wikilink in a loose list item's indented paragraph", async () => {
    const root = await makeVault({
      "Other.md": "# Other\n",
      "Steps.md": lines(
        "1. Step one",
        "",
        "    See [[Other]] for details.",
        "",
        "2. Step two",
        "",
        "Done.",
        "",
        "    [[Other]] here is indented code.",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const steps = entries.find((entry) => entry.ref === "Steps.md");
    // Four spaces under a list item is the item's continuation paragraph
    // (CommonMark 5.2), not an indented code block; after the list closes,
    // the same indentation is code again.
    expect(steps?.body.text).toContain("    See [Other](/other) for details.");
    expect(steps?.body.text).toContain("    [[Other]] here is indented code.");
  });

  it("does not let an escaped backtick open a code span", async () => {
    const root = await makeVault({
      "Other.md": "# Other\n",
      "Page.md": lines(
        "Escaped \\` then `code [[Other]]` after, and \\\\`[[Other]]` too.",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const page = entries.find((entry) => entry.ref === "Page.md");
    // `\`` is a literal backtick (CommonMark 2.4), so the span opens at the
    // next one and the link inside stays verbatim; `\\` escapes only the
    // backslash, so that backtick still opens a span.
    expect(page?.body.text).toContain("`code [[Other]]`");
    expect(page?.body.text).toContain("\\\\`[[Other]]`");
  });

  it("keeps a body that opens with a divider out of the frontmatter", async () => {
    const root = await makeVault({
      "Divider.md": lines(
        "---",
        "title: Divider",
        "---",
        "",
        "---",
        "",
        "Intro: with a colon.",
        "",
        "## Section",
        ""
      ),
    });
    const { entries } = await sourceFor(root).load();
    const [divider] = entries;
    // Re-emitting the note must not re-parse the body as a second front
    // matter block — js-yaml would throw on it, or swallow the intro.
    expect(divider?.raw).toBe(
      "---\ntitle: Divider\n---\n---\n\nIntro: with a colon.\n\n## Section\n"
    );
    expect(divider?.data).toEqual({ title: "Divider" });
  });

  it("keeps declared frontmatter keys and drops every other property", async () => {
    const root = await makeVault({
      "Daily.md": lines(
        "---",
        "title: Daily",
        "status: draft",
        "created: 2024-03-01",
        "publish: true",
        "tags: [a]",
        "---",
        "",
        "Text.",
        ""
      ),
    });
    const { entries } = await sourceFor(root, {
      frontmatterKeys: ["status", "tags"],
    }).load();
    // Blume's page meta and the project's declared keys survive; Templater
    // dates, `publish`, Dataview fields and the rest would fail the strict
    // schema and abort the build. Obsidian's own properties are dropped even
    // when declared — they are not Blume frontmatter.
    expect(entries[0]?.data).toEqual({ status: "draft", title: "Daily" });
  });

  it("places a localized note under its locale once, not twice", async () => {
    const root = await makeVault({
      "Guide.md": "See [[fr/Guide]].\n",
      "fr/Guide.md": "Voir [[Guide]].\n",
    });
    const { i18n } = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
    });
    const { entries } = await sourceFor(root, { i18n }).load();
    const fr = entries.find((entry) => entry.ref === "fr/Guide.md");
    const en = entries.find((entry) => entry.ref === "Guide.md");
    // The slug is built from the locale-stripped path — `normalizeEntry`
    // re-prefixes the locale itself, so a `fr/guide` slug would publish at
    // `/fr/fr/guide`. Hrefs carry the locale the target publishes under.
    expect(fr?.slug).toBe("guide");
    expect(en?.body.text).toContain("[fr/Guide](/fr/guide)");
    expect(fr?.body.text).toContain("[Guide](/guide)");
  });

  it("places a versioned note under its snapshot once, not twice", async () => {
    const root = await makeVault({
      "Guide.md": "See [[v1.0/Guide]].\n",
      "v1.0/Guide.md": "See [[Guide]].\n",
    });
    const { versions } = blumeConfigSchema.parse({
      versions: { archived: [{ id: "v1.0" }], current: { label: "v2.0" } },
    });
    const { entries } = await sourceFor(root, { versions }).load();
    const old = entries.find((entry) => entry.ref === "v1.0/Guide.md");
    const current = entries.find((entry) => entry.ref === "Guide.md");
    // `slugifyPath` would turn `v1.0` into `v10`; the version directory is
    // read off first and re-applied verbatim by the pipeline.
    expect(old?.slug).toBe("guide");
    expect(current?.body.text).toContain("[v1.0/Guide](/v1.0/guide)");
    expect(old?.body.text).toContain("[Guide](/guide)");
  });

  it("links a shared note in the linking note's own locale", async () => {
    const root = await makeVault({
      "Guide.md": "See [[Shared.$|Shared]] and [[Only]].\n",
      "Only.md": "# Only\n",
      "Shared.$.md": "Back to [[Guide]].\n",
      "fr/Guide.md": "Voir [[Shared.$|Shared]] et [[Only]].\n",
    });
    const { i18n } = blumeConfigSchema.parse({
      i18n: {
        defaultLocale: "en",
        // French first: the first configured locale is not the default one.
        locales: [
          { code: "fr", label: "Français" },
          { code: "en", label: "English" },
        ],
      },
    });
    const { entries } = await sourceFor(root, { i18n }).load();
    const en = entries.find((entry) => entry.ref === "Guide.md");
    const fr = entries.find((entry) => entry.ref === "fr/Guide.md");
    const shared = entries.find((entry) => entry.ref === "Shared.$.md");
    // `Shared.$.md` publishes in every locale, so each guide links to its
    // own copy — not to whichever locale happens to be configured first. A
    // note that publishes in one locale is linked there from anywhere.
    expect(en?.body.text).toContain("See [Shared](/shared) and [Only](/only).");
    expect(fr?.body.text).toContain(
      "Voir [Shared](/fr/shared) et [Only](/only)."
    );
    // A shared note has no single locale of its own; a target that publishes
    // in one locale is still linked there.
    expect(shared?.body.text).toContain("Back to [Guide](/guide).");
  });

  it("keeps a per-type frontmatter key only on notes of that type", async () => {
    const root = await makeVault({
      "Doc.md": "---\nrfcOwner: core\n---\n\nBody.\n",
      "Rfc.md": "---\ntype: rfc\nrfcOwner: core\n---\n\nBody.\n",
    });
    const { entries } = await sourceFor(root, {
      defaultType: "doc",
      typeFrontmatterKeys: { rfc: ["rfcOwner"] },
    }).load();
    const doc = entries.find((entry) => entry.ref === "Doc.md");
    const rfc = entries.find((entry) => entry.ref === "Rfc.md");
    // The meta parse carves out only the entry's own type's keys; a key
    // declared for another type would reach the strict page schema and drop
    // the note — the failure the allowlist exists to prevent.
    expect(doc?.data).toEqual({ title: "Doc" });
    expect(rfc?.data).toEqual({ rfcOwner: "core", title: "Rfc", type: "rfc" });
  });
});

describe("resolveSources (obsidian)", () => {
  const projectContext: ProjectContext = {
    componentsFile: null,
    configFile: null,
    contentRoot: "/p/docs",
    outDir: "/p/.blume",
    pagesRoot: null,
    root: "/p",
    themeFile: null,
  };

  it("wires an obsidian config into a staged source", () => {
    const config = blumeConfigSchema.parse({
      content: {
        sources: [
          {
            exclude: ["Templates"],
            prefix: "notes",
            type: "obsidian",
            vault: "vault",
          },
        ],
      },
    });
    const sources = resolveSources(config, projectContext, { mode: "build" });
    expect(sources[0]?.name).toBe("notes");
    expect(sources[0]?.prefix).toBe("notes");
    expect(sources[0]?.staged).toBe(true);
  });

  it("names an unprefixed obsidian source after its type", () => {
    const config = blumeConfigSchema.parse({
      content: { sources: [{ type: "obsidian", vault: "vault" }] },
    });
    const sources = resolveSources(config, projectContext, { mode: "build" });
    expect(sources[0]?.name).toBe("obsidian");
    expect(sources[0]?.prefix).toBeUndefined();
  });

  it("threads declared frontmatter keys and routing config into the source", async () => {
    const root = await makeVault({
      "fr/Guide.md":
        "---\ntype: rfc\nowner: docs\nrfcOwner: core\nstatus: draft\n---\n\nBody.\n",
    });
    const config = blumeConfigSchema.parse({
      content: {
        sources: [{ type: "obsidian", vault: root }],
        types: { rfc: { frontmatter: { rfcOwner: z.string() } } },
      },
      frontmatter: { extend: { owner: z.string() } },
      i18n: {
        defaultLocale: "en",
        locales: [
          { code: "en", label: "English" },
          { code: "fr", label: "Français" },
        ],
      },
    });
    const sources = resolveSources(config, projectContext, { mode: "build" });
    const loaded = await sources[0]?.load();
    const [guide] = loaded?.entries ?? [];
    // Site-wide and the note's own type's declarations survive; `status`
    // does not.
    expect(guide?.data).toEqual({
      owner: "docs",
      rfcOwner: "core",
      title: "Guide",
      type: "rfc",
    });
    expect(guide?.slug).toBe("guide");
  });

  it("rejects an empty vault path", () => {
    // `""` resolves to the project root, so the walk would treat node_modules
    // and build output as vault content.
    expect(() =>
      blumeConfigSchema.parse({
        content: { sources: [{ type: "obsidian", vault: "" }] },
      })
    ).toThrow();
  });

  it("rejects an obsidian source with no vault", () => {
    expect(() =>
      blumeConfigSchema.parse({
        content: { sources: [{ type: "obsidian" }] },
      })
    ).toThrow();
  });
});
