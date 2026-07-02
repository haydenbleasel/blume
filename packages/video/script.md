# Blume — Launch Video Script

**Runtime:** 60 seconds · 1800 frames @ 30fps · 1280×720 (the reference stage size the remocn components assume) **Style:** On-screen text only, no voiceover. Music-driven. Must play well muted. **Tone:** Confident and minimal. Short declarative lines. Let the motion carry it — never two ideas on screen at once. **Look:** Light theme throughout, matching the remocn defaults — near-black text (`#171717`) on white/off-white, Geist Sans, tight letter-spacing. The terminal and glass-code scenes provide the only dark surfaces, which makes them land harder. **Music:** Minimal electronic with a clear pulse. One build into the Scene 2 reveal, a second build into the Scene 7 end card. Cut scene transitions on the beat.

---

## Scene 1 — The hook (0:00–0:07 · frames 0–210)

Open on white. Silence for a half-beat, then the music pulse starts.

**On-screen copy:**

1. `Every docs site starts the same way.` — resolves out of a blur into sharp focus, holds, then blurs back out and drifts up.
2. `Clone a starter.` → `Fight the config.` — word-level crossfade between the two pains.
3. `Maintain the boilerplate. Forever.` — quick final swap, then hard cut to Scene 2 on the downbeat.

**Components:**

- Beat 1: `FocusBlurResolve` — `text="Every docs site starts the same way."`, default `blur={14}`. Its built-in exit (blur-out + upward drift) is the transition into beat 2; give it its own `Sequence` (~90 frames) so the exit fires on time.
- Beats 2–3: two chained `PerWordCrossfade`s — first `fromText="Clone a starter." toText="Fight the config."`, then `fromText="Fight the config." toText="Maintain the boilerplate. Forever."`. Drop `fontSize` to ~56 so the longest line fits comfortably.

**Timing:** beat 1 ≈ frames 0–90, beat 2 ≈ 90–150, beat 3 ≈ 150–210.

---

## Scene 2 — The reveal (0:07–0:11 · frames 210–330)

The music opens up. This is the name-drop.

**On-screen copy:**

1. `Blume` — large, characters de-blurring in one by one. Hold for a beat.
2. `World-class docs for everything you ship.` — words build kinetically from the center, each new word pushing the phrase outward so it stays perfectly centered.

**Components:**

- `Backdrop` — subtle off-white `gradient` fill behind both beats to lift this scene apart from the flat white of Scene 1.
- Beat 1: `SoftBlurIn` — `text="Blume"`, `fontSize={120}`, default `blur={12}`. (~45 frames)
- Beat 2: `KineticCenterBuild` — `text="World-class docs for everything you ship."`, `fontSize={64}`. Six words need room to build — give it the remaining ~75 frames and nudge `speed={1.15}` if it runs long.

---

## Scene 3 — The money shot (0:11–0:22 · frames 330–660)

One unbroken terminal take: install → init → dev server ready. This is the whole pitch in eleven seconds.

**On-screen visual:** mac-style terminal window, centered, typing in bursty human chunks:

```
$ npm i blume
added 1 package in 2.1s
$ blume init
✓ Created docs/
✓ Created blume.config.ts
$ blume dev
✓ Ready in 180ms
→ http://localhost:4321
```

**Caption** (fades in under the terminal once `Ready in 180ms` lands):

`The framework is the template.`

**Components:**

- `TerminalSimulator` — `title="~/acme"`, `prompt="$"`, `lines` per the block above: commands as `type: "command"`, the `added 1 package` and URL lines as `type: "log"`, the `✓` lines as `type: "success"`. Use `delay` before each command (~15 frames) so the three commands read as three deliberate actions, and a `pause` after `blume dev` before the ready line to sell the (tiny) wait.
- `MicroScaleFade` — `text="The framework is the template."`, `fontSize={36}`, positioned below the terminal, sequenced to start around frame 600.

**Transition:** hold the finished terminal for a beat, then Scene 4's frosted-glass wipe carries us out.

---

## Scene 4 — Markdown in, docs out (0:22–0:32 · frames 660–960)

Show the input honestly: it's just a Markdown file — but one with superpowers.

**On-screen visual, beat 1 (~frames 660–850):** a frosted-glass code editor. The camera zooms in and pans down the file line by line as it reveals, then pulls back to show the whole thing:

````mdx
---
title: Send your first email
description: From API key to inbox in five minutes.
---

Install the SDK to get started:

```package-install
comet
```

:::note Sandbox keys are free — no credit card required. :::
````

_(The "Comet" fictional brand matches the product mock on the Blume homepage — keep the fiction consistent.)_

**Beat 2 (~frames 850–960):** a frosted-glass bar sweeps across the frame, swapping the raw MDX for the rendered result — a clean docs page mock with sidebar, the note rendered as a callout, and `package-install` rendered as npm/pnpm/bun/yarn tabs. Over it, two stacked lines rise in:

```
Markdown in.
Docs out.
```

**Components:**

- Beat 1: `GlassCodeWalk` — `code` = the MDX above, `title="docs/quickstart.mdx"`, default `zoom={2.6}`. Trim the code if the walk runs long; the frontmatter, `package-install` fence, and `:::note` directive are the three lines that must survive.
- Beat 2: `FrostedGlassWipe` — `from` = the settled `GlassCodeBlock`, `to` = the rendered docs-page mock (static frame or lightweight JSX), `transitionDuration={30}`.
- Caption: `MaskRevealUp` — `text={"Markdown in.\nDocs out."}` — it splits on `\n` and staggers the two lines, and its built-in exit clears the frame for Scene 5.

---

## Scene 5 — The feature run (0:32–0:41 · frames 960–1230)

Pace change: hard, snappy, one claim per beat, cut on the music. No decoration — just type.

**On-screen copy, five snaps then a landing:**

1. `Zero config.`
2. `Zero client JavaScript.`
3. `Search built in.`
4. `OpenAPI references.`
5. `OG images at build.`
6. **Landing:** `Batteries included.` — springs in word by word with overshoot, holds.

**Components:**

- Snaps 1–5: chained `SharedAxisY` swaps — its stepped, no-blur word transitions are exactly this beat. Pairs: `fromText`/`toText` walking down the list (`"Zero config." → "Zero client JavaScript."`, etc.), ~40 frames per swap.
- Landing: `SpringScaleIn` — `text="Batteries included."`, `fontSize={88}`, default stagger. The bounce is the exclamation point after five flat snaps.

**Timing:** snaps ≈ frames 960–1160, landing ≈ 1160–1230.

---

## Scene 6 — Built for humans and models (0:41–0:51 · frames 1230–1530)

The differentiator. Two beats: docs that answer questions, and docs that agents can use.

**Beat 1 (~frames 1230–1380):** the Ask-AI chat card bounces in and a question types itself into the input; the mic button morphs into a send button as typing starts. Caption above: `Ask AI, in the page.`

**Beat 2 (~frames 1380–1530):** cut to a constellation — a pulsing **B** at the center, agent/tool logos orbiting it, connection lines periodically firing inward. Caption: `Built for humans and models.` with a quiet subline: `llms.txt · MCP server · Markdown at every URL`

**Components:**

- Beat 1: `ClaudeChat` — `prompt="How do I authenticate with the Comet API?"`, `greeting`/`placeholder` kept generic. Note: its built-in accent is Anthropic orange (`#D97757`) — pass `accentColor` with Blume's brand color instead so this reads as Blume's Ask AI, not a Claude ad.
- Beat 1 caption: `MicroScaleFade` — `text="Ask AI, in the page."`, `fontSize={32}`, above the card.
- Beat 2: `EcosystemConstellation` — `centerLabel="B"`, `satelliteCount={6}`, `accentColor` = Blume brand color.
- Beat 2 captions: `ShortSlideRight` — `text="Built for humans and models."`, `fontSize={48}`; subline as a second `ShortSlideRight` at `fontSize={22}`, lower opacity, delayed ~15 frames.

---

## Scene 7 — Migrate + CTA (0:51–1:00 · frames 1530–1800)

**Beat 1 (~frames 1530–1650):** one last quick terminal hit — already have docs somewhere else? One command:

```
$ npx blume migrate mintlify
✓ Migrated 148 pages
```

**Beat 2 (~frames 1650–1740):** the end-card line, bridged from the migrate beat by a word-level crossfade:

`Migrate in one command.` → `Documentation for everything you build.`

**Beat 3 (~frames 1740–1800):** the close. Centered, typed out with a blinking caret that stays alive to the final frame:

`npm i blume`

Small line beneath it: `Free and open source, forever.`

**Components:**

- Beat 1: `TerminalSimulator` — `title="~/acme"`, two lines (`command`, then `success`), `charsPerFrame={2}` so it types faster than Scene 3 — this is a coda, not a demo.
- Beat 2: `PerWordCrossfade` — `fromText="Migrate in one command."`, `toText="Documentation for everything you build."`, `fontSize={56}`.
- Beat 3: `Typewriter` — `text="npm i blume"`, `fontSize={64}`, `charsPerSecond={16}`, `cursor` on; the `Caret` blink runs out the clock. `MicroScaleFade` — `text="Free and open source, forever."`, `fontSize={26}`, muted color, fading in ~20 frames after typing completes.

Music resolves; caret blinks twice on silence. Cut to black.

---

## Copy bank (alternates / spares)

- Hook alternates: `Docs shouldn't need a scaffold.` · `You wanted docs. You got a codebase.`
- Tagline alternate (README lead): `Documentation for everything you build.` (used as the end-card bridge above; can swap with the hero tagline in Scene 2)
- Feature-run spares: `Type-safe config.` · `30+ components, no imports.` · `Mermaid and math, built in.` · `36 locales, full RTL.` · `Deploy anywhere.`
- AI scene spares: `Copy as Markdown.` · `Open in ChatGPT, Claude, v0.` · `Four MCP tools, zero setup.`
- CTA subline alternate: `Fast, AI-ready, and zero-config.`

## Production notes

- Every claim above is real product copy — sourced from the root `README.md`, the docs homepage sections (`apps/docs/pages/_home/`), and the CLI reference. Don't soften or embellish; the restraint is the brand.
- All remocn components accept a `speed` multiplier — tune pacing against the final music track with `speed`, not by re-cutting `Sequence` boundaries.
- The current `root.tsx` composition is a 60-frame stub — the final composition needs `durationInFrames={1800}` at the existing 30fps / 1280×720.
- If a social cut is needed later: Scenes 2 + 3 + 7 alone are a clean 25-second teaser.
