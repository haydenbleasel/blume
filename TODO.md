# Blume — TODO

## P2 — Concrete smaller gaps

### Errors & diagnostics (plan 18)

- [ ] Dev overlay (Blume diagnostics bridged into Vite/Astro overlay with snippet + fix + docs link)
- [ ] Remap `.blume/` stack frames back to user source
- [ ] Missing-component diagnostic (unknown MDX tag → suggest `blume add`)
- [ ] Hydration-mismatch diagnostic

### Navigation (plan 06)

### Deployment (plan 19)

- [ ] Emit platform redirect files (`_redirects` / `vercel.json`) + a redirect manifest for hosts needing manual wiring
- [ ] Env-var fail-fast when a feature needs a secret (AI Gateway token, analytics keys, feedback creds)

### Config (plan 04)

- [ ] Resolve orphan config fields (favicon/navbar/footer/icons/contextual/styling/banner) — prune or wire

### Content types & meta (plan 15 / 17)

---

## P3 — Tooling & quality (plan 13 / 14)

- [ ] Fixture matrix (static/server deploy, broken links, invalid frontmatter, nested nav, custom `.astro`, React island, migration samples)
- [ ] Playwright e2e (nav, mobile sidebar, search modal, tabs/accordions, theme toggle, code copy, Ask AI shell, custom pages)
- [ ] Visual regression tests + automated accessibility checks (axe, focus trap, contrast, reduced motion)
- [ ] Performance-budget tooling (budgets are documented, not measured)
