---
"blume": minor
---

Icons now resolve from the full open icon libraries — **Font Awesome** (free), **Lucide**, and **Tabler**, the three Mintlify exposes — instead of a hand-curated subset. Resolution happens at build time and inlines zero-JS SVG, so there's no runtime CDN fetch (unlike Mintlify) and unused icons cost nothing on the client.

- New `icons.library` config picks the default library for bare names (`"lucide"` default, or `"fontawesome"` / `"tabler"`).
- `iconType` selects a Font Awesome style (`solid`, `regular`, `brands`); Pro-only styles (`light`, `thin`, `duotone`, `sharp-solid`) aren't in the free data and fall back to solid.
- An explicit `library:name` prefix (`fa6-brands:github`, `lucide:rocket`, `tabler:heart`) overrides the default per icon, so libraries can be mixed.
- Font Awesome brand names resolve even under the solid default (`icon="github"` finds the brands set).
- The Mintlify migrator sets `icons.library: fontawesome` (Mintlify's default), so a migrated site's existing Font Awesome icon names — previously mostly unresolved — now render.

The curated inline-SVG set and its FontAwesome alias map are gone; a small internal set is kept only for Blume's own client-side chrome (copy/search/etc.). The five Iconify data packages are build-time dependencies (server-side only), so they add nothing to shipped pages.
