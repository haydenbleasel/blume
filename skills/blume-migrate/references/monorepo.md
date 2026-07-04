# Migrating into a real repo (monorepos, pnpm, Vercel)

The framework references (`mintlify.md`, etc.) cover translating _content and config_. This file covers the **host repo** the docs live in — the concerns that surface when the target isn't a bare docs folder but a pnpm/Turbo workspace deployed on Vercel. All six were real failures in a production migration; none are Blume bugs, they're integration steps.

**Golden rule for this whole file: detect, then edit surgically, then say what you changed and why.** Every edit here touches a file the repo owns (`pnpm-workspace.yaml`, `vercel.json`, `package.json`, the lockfile). Never guess a path depth or a workspace name — read it out of the repo first. Where a step can't be fully automated (the Astro patch, the Vercel Root Directory setting), leave a copy-pasteable manual instruction rather than a half-applied change.

---

## 1. Non-standard content layout → scope `content.root` + `include`

`content.root` defaults to `"docs"`, and `blume` runs from the directory that holds `blume.config.ts` (in a monorepo, that's the docs _package_, e.g. `apps/docs/`). Many repos **don't** have a `docs/` subfolder — the content sits directly under the app dir in topic folders (`apps/docs/api/`, `apps/docs/getting-started/`). With the default root, Blume looks for `apps/docs/docs/` and finds nothing.

**Detect by finding where `.md`/`.mdx` actually live** — never assume `docs/`. From the docs package dir:

```bash
# top two path segments of every content file, deduped — your content folders
find . -path ./node_modules -prune -o \( -name '*.md' -o -name '*.mdx' \) -print \
  | sed 's|^\./||' | cut -d/ -f1 | sort -u
```

If that lists a real `docs` folder, keep the default. If it lists content folders directly (`api`, `getting-started`, `guides`), the content root is the package dir itself.

**Set `content.root` to the package dir and scope with explicit `include` globs — do _not_ use `content.root: "."` alone.** A bare `.` root scans the whole package: `src/`, `public/`, `README.md`, config files, and (in a monorepo) anything a loose glob reaches. That's slow and pulls non-content Markdown into the site. Instead pin `root` and list the real content folders in `content.include`:

```ts blume.config.ts
import { defineConfig } from "blume";

export default defineConfig({
  content: {
    root: ".", // content sits directly under this package (apps/docs/), no docs/ subfolder
    // include/exclude globs are relative to `content.root`. List the actual
    // content folders so the scan never wanders into src/, public/, etc.
    include: [
      "api/**/*.{md,mdx}",
      "getting-started/**/*.{md,mdx}",
      "guides/**/*.{md,mdx}",
    ],
    exclude: ["**/node_modules/**", "**/_*", "**/.*"],
  },
});
```

Schema field names, exactly: **`content.root`** (string, relative to the project/cwd), **`content.include`** (array of globs, relative to `content.root`, default `["**/*.{md,mdx}"]`), **`content.exclude`** (array of globs, relative to `content.root`, default `["**/_*", "**/.*"]`). Singular `include`/`exclude`, both arrays.

Report to the user: the detected content root, the folders you scoped `include` to, and anything Markdown you deliberately left out (a top-level `README.md`, a `CHANGELOG.md`) so they can confirm it isn't content.

---

## 2. pnpm `minimumReleaseAge` blocks installing fresh Blume

pnpm's supply-chain guard (`minimumReleaseAge`, often set to `1440` = 24h) refuses to install any package version published more recently than the window. Right after Blume publishes, that's **every** Blume release — so `pnpm add blume` / the workspace install fails or silently pins an older version.

**Do not disable the policy globally** — that removes the guard for the whole dependency tree. Add **only `blume`** to the exclude list.

**Detect** in `pnpm-workspace.yaml` (pnpm 10+, the primary location) and, for older setups, `.npmrc`:

```bash
grep -rn "minimumReleaseAge\|minimum-release-age" pnpm-workspace.yaml .npmrc 2>/dev/null
```

**Fix — `pnpm-workspace.yaml`** (surgical add; create the key if the policy is set but no exclude exists):

```yaml
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - blume
```

**Fix — `.npmrc`** form (if the policy lives there instead):

```ini
minimum-release-age=1440
minimum-release-age-exclude[]=blume
```

Report: "Added `blume` to `minimumReleaseAgeExclude` so the just-published version installs; the release-age guard still applies to everything else."

---

## 3. Frozen lockfile — regenerate and commit `pnpm-lock.yaml` in the same change

CI and Vercel install with `--frozen-lockfile` (pnpm's default in CI): if `package.json` and `pnpm-lock.yaml` disagree by even one dependency, the install **fails immediately** — before any build step runs. A migration always edits dependencies (add `blume`, drop the old framework), so the lockfile is guaranteed stale.

**After every dependency edit, regenerate the lockfile and stage it with the manifest:**

```bash
pnpm install            # NOT --frozen-lockfile — this rewrites pnpm-lock.yaml
git add package.json apps/docs/package.json pnpm-lock.yaml
```

Rules:

- Run `pnpm install` (plain) from the **workspace root**, not the docs package, so the single root lockfile updates.
- The lockfile change belongs in the **same commit** as the `package.json` change. A commit that edits deps without the matching lockfile is a broken build for anyone who pulls it.
- Verify locally the way CI will: `pnpm install --frozen-lockfile` should succeed with no diff. If it errors "lockfile not up to date," you forgot the plain install.

---

## 4. Vercel monorepo recipe (root-aware install + build)

A plain `blume build` works locally, but Vercel in a workspace needs three things aligned: the install must run at the **workspace root** (so pnpm resolves the whole graph under a frozen lockfile), the build must run in the **docs package**, and Vercel must be pointed at the built `dist/`. `blume build` emits a static site to `dist/` **relative to where it runs** — so building in `apps/docs/` produces `apps/docs/dist/`.

This is a **copyable template**, not prose. Three pieces:

**a) Docs package `apps/docs/package.json`** — the standard Blume scripts:

```json
{
  "scripts": {
    "dev": "blume dev",
    "build": "blume build",
    "preview": "blume preview"
  },
  "dependencies": {
    "blume": "^1"
  }
}
```

**b) `apps/docs/vercel.json`** — root-aware install, local build, `dist` output:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "cd ../.. && pnpm install --frozen-lockfile",
  "buildCommand": "pnpm run build",
  "outputDirectory": "dist"
}
```

**c) The one setting `vercel.json` can't hold — set it in the Vercel project (dashboard → Settings → General, or `vercel` CLI):**

- **Root Directory** = `apps/docs`. This makes install/build/output paths resolve from the docs package, which is what the `vercel.json` above assumes.
- **Node version** = 22 or newer (Blume requires it). Or pin it in the docs package: `"engines": { "node": ">=22" }`.

How the pieces fit, with Root Directory = `apps/docs`:

- `installCommand` does `cd ../..` to reach the **workspace root** and runs a frozen install of the whole graph. **Adjust `../..` to the app's actual depth** — an app at `packages/web/docs/` needs `cd ../../..`. Read the path; don't assume two levels.
- `buildCommand` runs in `apps/docs/` and invokes `blume build` (via the package's `build` script) → emits `apps/docs/dist/`.
- `outputDirectory: "dist"` is relative to the Root Directory (`apps/docs`), so it points at `apps/docs/dist/`.
- `framework: null` stops Vercel from auto-detecting Astro and overriding your build/output with its Astro preset (which expects a different output path). Blume's static output is plain files — Vercel just serves the folder.

If the repo uses **Turborepo**, you can instead build through the root pipeline — `"buildCommand": "cd ../.. && pnpm turbo build --filter=docs"` — for remote-cache reuse. Keep `outputDirectory: "dist"` and Root Directory `apps/docs`.

Report every piece you wrote and the two dashboard settings the user must set by hand (Root Directory, Node version) — those can't be committed.

Redirects still work as normal: a static build emits `vercel.json` redirect rules into `dist/`. If you commit your own `apps/docs/vercel.json` (as above), Blume leaves a `public/vercel.json` untouched — so put redirect overrides in `public/vercel.json`, not the project-root one, to avoid a collision. (Most migrations use `blume.config.ts` `redirects` and never touch this.)

---

## 5. Astro/Vite version mismatch → pnpm patch (manual)

Blume pins **`astro ^7`**. If the workspace forces a specific **Vite** version — a root `pnpm.overrides` / `resolutions` entry, or a `vite` in the workspace catalog — that pinned Vite can diverge from the version Astro 7 expects, and Astro's internal build behavior mismatches. The symptom is a **build-time crash inside Astro/Vite** (a Rollup/Vite internal error, a missing-export or hook-signature error deep in `astro`/`vite` during `blume build`) that doesn't reproduce in a clean, override-free project.

**Detect the risk factor** before it bites:

```bash
grep -rn "\"vite\"\|vite@\| vite:" pnpm-workspace.yaml package.json 2>/dev/null | grep -i "override\|resolution\|catalog\|vite"
```

Blume is adding early version validation separately, so a future release will flag this at startup. Until then, **recognize the symptom and apply a pinned patch** — pnpm's `patch` workflow writes a committed diff that pnpm reapplies on every install (survives CI and frozen installs):

```bash
# 1. Open the offending version in an editable temp dir (use the exact version
#    pnpm resolved — check `pnpm why astro`):
pnpm patch astro@7.0.6

# 2. Edit files in the printed temp path to reconcile the Astro/Vite interface
#    (the exact edit depends on the mismatch; the crash's stack trace names the
#    file and call site). Then commit the patch:
pnpm patch-commit '<the temp path pnpm printed>'
```

`patch-commit` writes `patches/astro@7.0.6.patch` and registers it under `patchedDependencies` in `pnpm-workspace.yaml` (pnpm 10+) or root `package.json` (`pnpm.patchedDependencies` on pnpm 9):

```yaml
# pnpm-workspace.yaml
patchedDependencies:
  astro@7.0.6: patches/astro@7.0.6.patch
```

Commit **both** `patches/astro@7.0.6.patch` and the `patchedDependencies` entry, then re-run `pnpm install` and `blume build`.

This is a **manual step — do not fabricate the patch contents.** Leave the user this exact recipe plus the crash's stack trace, and tell them: the cleaner long-term fix is to relax the workspace's Vite pin so Astro 7 resolves its own compatible Vite, and drop the patch once Blume ships version validation. Don't fail silently — if a build crashes inside Astro/Vite and a Vite override exists, name this as the likely cause.

---

## Checklist for a workspace migration

- [ ] Located real content folders (not assumed `docs/`); set `content.root` + scoped `content.include`.
- [ ] `minimumReleaseAge` present? Added `blume` to `minimumReleaseAgeExclude` only.
- [ ] Ran plain `pnpm install`; committed `pnpm-lock.yaml` with the `package.json` change; verified `pnpm install --frozen-lockfile` is clean.
- [ ] Wrote `apps/docs/vercel.json` + package scripts; told the user to set Root Directory + Node 22 in the Vercel project.
- [ ] Checked for a workspace Vite override; if the build crashes inside Astro/Vite, gave the pnpm-patch recipe.
- [ ] Reported every repo-specific edit and every manual step left to the user.
