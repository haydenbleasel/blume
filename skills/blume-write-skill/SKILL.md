---
name: blume-write-skill
description: Write the agent skill for a product's Blume docs site — one SKILL.md, grounded in the docs, that teaches a coding agent to use the product (setup, core concepts, common tasks, gotchas) and links each topic's page. Blume publishes it at the site's /skill.md in place of the page map it generates. Use when asked to write, improve, or refresh a docs site's agent skill, or when `blume skill` hands you this task.
---

# Write a docs site's agent skill

Every Blume site already publishes a generated skill at `/skill.md`: a map of its pages with their one-line descriptions, built without a model. It tells an agent where things are, not how the product works. Your job is to write the skill that does: what the product is, how to set it up, the concepts and tasks that matter, and where it bites, with every topic linked to the page that covers it.

The reader is a coding agent working in someone else's project. It loaded your skill because a task touches this product, and it needs to act correctly without reading the whole site first.

## Ground rules

- **Only what the docs say.** Every claim, command, config key, flag, environment variable, and code sample must come from a page in the content root, copied rather than paraphrased. Never fill a gap from memory or from what similar products do. Where the docs don't answer something the skill needs, leave it out and list it in your report as a docs gap.
- **One file.** Keep it a lone `SKILL.md`: no `references/`, `scripts/`, or `assets/`. A single file is what the site serves at `/skill.md` and what an agent can fetch in one request. Depth lives in the docs, so link to them instead of copying them in.
- **Absolute links to Markdown.** Link pages as `<site><route>.md` (the home page is `<site>/index.md`), using the site URL your prompt gives. Link only pages that exist: a page's route is its path under the content root without the extension, and a folder's `index` page takes the folder's route.
- **Keep the given name.** The frontmatter `name` must be exactly the one in your prompt. That match is what makes your skill replace the generated one.
- **Short beats complete.** Aim for well under 300 lines. Skip anything a capable agent already knows (general programming, Markdown, how HTTP works) and anything it can look up from a link when it needs it.

## Workflow

1. **Read the docs.** Start with `blume.config.ts` (the site's title, description, `content.root`, navigation, API references) and the `meta.ts` files, which give the sidebar order. Then read the home page, the quickstart or installation page, each core-concept page, the configuration reference, the API reference overview, and any troubleshooting or FAQ pages. If the site has been built, its `llms.txt` lists every page with its description.

2. **Decide what matters.** Before writing, note:
   - the product in two or three sentences: what it is, who uses it, and how it's installed or reached
   - the five to ten tasks people most often come to the docs to do
   - the concepts an agent must understand to do those tasks right
   - the sharp edges: limits, required setup, defaults that surprise people, common errors, and anything deprecated along with what replaced it

3. **Write the skill.** Use this shape, dropping any section the docs give you nothing for:

   ```markdown
   ---
   name: <the name from your prompt>
   description: <What the product is and when to use this skill, in the words a user would type: the product name, its package and CLI names, its key concepts. At most 1024 characters.>
   ---

   # <Product>

   <Two or three sentences: what it is, who it's for, how to install or reach it.>

   ## Setup

   <Install, configure, and authenticate, verbatim from the docs, with a link to the page.>

   ## Core concepts

   - **<Concept>**: <one line>. [<Page title>](<site><route>.md)

   ## Common tasks

   ### <Task>

   1. <Step, with the exact command or code from the docs.>

   See [<Page title>](<site><route>.md).

   ## Gotchas

   - <The limit, default, or error, and what to do about it.>

   ## Where to look

   - [<Section>](<site><route>.md): <when to read it>
   - [llms.txt](<site>/llms.txt): every page with a one-line summary.
   ```

   The `description` decides whether an agent loads the skill at all, so spend time on it. Name the product the way users do, and cover the situations it's for ("setting up X", "calling the X API", "configuring X"). Write the body in the imperative, for an agent that will act on it.

   If the site serves an MCP server or other agent surfaces, the generated skill names them. Carry those lines over under "Where to look".

4. **Check it.**
   - Every link points at a page that exists in the content root, as `<site><route>.md`.
   - Every command, code sample, config key, and default appears in the docs as written.
   - The frontmatter parses, `name` is exactly as given, and `description` is 1024 characters or fewer.
   - Then run the docs build (`blume build`). The build output's `skill.md` should now be yours, and `.well-known/agent-skills/index.json` should list the name once.

5. **Report.** Say where you wrote the skill and any config you changed, summarize what it covers, and list the docs gaps you found: questions the skill needed answered that no page does. Those are worth fixing in the docs.

## Keeping it current

A hand-written skill doesn't update itself the way the generated one does. After a meaningful docs change (new features, renamed APIs, a changed setup flow), run `blume skill` again to refresh it. Update the existing file rather than starting over, and keep what's still true.
