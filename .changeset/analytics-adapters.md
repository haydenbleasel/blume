---
"blume": major
---

Replace the `analytics` object with a list of adapters imported from `blume/analytics`. Where the config used to name providers as sibling keys (`analytics.posthog`, `analytics.vercel`, `analytics.cloudflare`, `analytics.scripts`), it now lists what to emit, in order:

```ts
import { cloudflare, posthog, script, vercel } from "blume/analytics";

export default defineConfig({
  analytics: [
    posthog({ key: "phc_…" }),
    vercel(),
    cloudflare({ token: "…" }),
    script({ src: "https://plausible.io/js/script.js", strategy: "defer" }),
  ],
});
```

Each adapter returns a plain, serializable descriptor (`kind`, `options`, `runtimeDeps`, `requiredSecrets`) that the config schema validates and the generated site inlines as a literal; `blume doctor`, the secrets check, and the generated `package.json` read the descriptor instead of switching on a provider name. Every adapter forwards the options Blume doesn't name verbatim — extra `posthog()` keys land in `posthog.init`, extra `cloudflare()` keys in the beacon's `data-cf-beacon` JSON, and extra `vercel()` keys become props of the official component — and `script()`'s `attributes` stays the passthrough for a raw tag. The object form is gone: a config that still uses it fails validation with a hint pointing at the list form. To migrate, move each key to its adapter — `posthog: { key, host }` → `posthog({ key, host })`, `vercel: true` → `vercel()`, `cloudflare: { token }` → `cloudflare({ token })`, and each `scripts[]` entry → `script({ … })`.
