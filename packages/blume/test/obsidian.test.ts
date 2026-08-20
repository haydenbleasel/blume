import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { blumeConfigSchema } from "../src/core/schema.ts";
import { obsidianSource } from "../src/core/sources/obsidian.ts";
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
  options: { exclude?: string[]; prefix?: string; vault?: string } = {}
) =>
  obsidianSource(
    {
      exclude: options.exclude,
      name: "obsidian",
      prefix: options.prefix,
      vault: options.vault ?? ".",
    },
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
    expect(entries.map((entry) => entry.ref)).toEqual([
      "Index.md",
      "guides/Getting Started.md",
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
    expect(entries[0]?.body.text).toContain("See Nowhere.");
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

  it("read() refuses a ref that resolves outside the vault", async () => {
    const root = await makeVault(BASIC);
    // No load has run, so the snapshot cannot vouch for the ref.
    await expect(
      sourceFor(root, { vault: "guides" }).read?.("../Index.md")
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
      "Links.md": "See [[Setup]].\n",
      "Setup.md": "# Root setup\n",
      "guides/Setup.md": "# Guide setup\n",
    });
    const { entries, diagnostics } = await sourceFor(root).load();
    const links = entries.find((entry) => entry.ref === "Links.md");
    expect(links?.body.text).toContain("[Setup](/setup)");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("BLUME_WIKILINK_AMBIGUOUS");
    expect(diagnostics[0]?.message).toContain("Setup.md");
    expect(diagnostics[0]?.message).toContain("guides/Setup.md");
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

  it("read() serves the staged text after a load", async () => {
    const root = await makeVault(BASIC);
    const source = sourceFor(root);
    await source.load();
    const raw = await source.read?.("guides/Getting Started.md");
    expect(raw).toContain("title: Getting started");
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
