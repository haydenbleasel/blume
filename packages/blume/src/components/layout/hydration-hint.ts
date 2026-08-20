// Dev-only: when React reports a hydration mismatch for an island, follow it
// with a friendly Blume hint pointing at the islands guide. Guarded by
// `import.meta.env.DEV`, so the whole block is tree-shaken out of production
// builds (the module ships no runtime code there).

const HINT =
  "[blume] A hydration mismatch was detected in an island. Make sure props passed from `.astro`/MDX are serializable and the component renders the same output on the server and client (avoid `Date.now()`, `Math.random()`, `window` at render time). See https://useblume.dev/docs/content/islands";

const PATTERNS = [
  /hydrat/iu,
  /did not match/iu,
  /server-rendered html/iu,
  /server rendered html/iu,
];

if (import.meta.env.DEV && "window" in globalThis) {
  const original = console.error.bind(console);
  let shown = false;
  console.error = (...args: unknown[]) => {
    original(...args);
    if (shown) {
      return;
    }
    const text = args.map(String).join(" ");
    if (PATTERNS.some((pattern) => pattern.test(text))) {
      shown = true;
      original(HINT);
    }
  };
}
