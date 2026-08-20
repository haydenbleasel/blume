// Mirrors the fence masking in `core/sources/assets.ts`: a fenced code sample
// that *shows* `<Visibility>` markup must keep showing what the author wrote.
const CODE_FENCE_BLOCK =
  /^(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?^\k<fence>[^\n]*(?=\n|$)/gmu;
// NUL delimiters cannot appear in authored markdown, so tokens never collide.
// oxlint-disable-next-line no-control-regex -- the NUL is the collision guard.
const FENCE_TOKEN = /\u0000blume-fence-(?<index>\d+)\u0000/gu;

/** The audience an output surface serves — the component's two `for` values. */
export type VisibilityAudience = "agents" | "web";

// `<Visibility for="…">…</Visibility>` in either quote style, tolerant of
// whitespace around the attribute and inside the tags. Non-greedy bodies stop
// at the first close tag, so nesting is not supported: a nested block closes
// the outer match early and any remainder passes through verbatim.
const visibilityBlock = (audience: VisibilityAudience): RegExp =>
  new RegExp(
    `<Visibility\\s+for\\s*=\\s*(?:"${audience}"|'${audience}')\\s*>(?<inner>[\\s\\S]*?)</Visibility\\s*>`,
    "gu"
  );

const BLOCKS = {
  agents: visibilityBlock("agents"),
  web: visibilityBlock("web"),
} satisfies Record<VisibilityAudience, RegExp>;

/**
 * Resolve `<Visibility>` blocks for one audience: blocks addressed to the
 * other audience are removed entirely and blocks addressed to `audience` are
 * unwrapped (tags dropped, body kept), matching what the Astro component
 * renders on the web. Other `for` values (the component's default) are left
 * untouched, and markdown with no matching blocks is returned byte-identical,
 * so raw sources stay raw.
 */
export const applyAudienceVisibility = (
  markdown: string,
  audience: VisibilityAudience
): string => {
  // Mask fenced code blocks so documentation *about* Visibility survives.
  const fences: string[] = [];
  const masked = markdown.replace(CODE_FENCE_BLOCK, (block) => {
    fences.push(block);
    return `\u0000blume-fence-${fences.length - 1}\u0000`;
  });

  let touched = false;
  const filtered = masked
    .replaceAll(BLOCKS[audience === "agents" ? "web" : "agents"], () => {
      touched = true;
      return "";
    })
    .replaceAll(BLOCKS[audience], (_match, inner: string) => {
      touched = true;
      return inner;
    });

  // Removing/unwrapping block-level tags leaves runs of blank lines behind;
  // collapse them only when something matched so untouched files round-trip
  // exactly. Fences are masked as single-line tokens, so they are unaffected.
  const tidied = touched ? filtered.replaceAll(/\n{3,}/gu, "\n\n") : filtered;

  return tidied.replaceAll(
    FENCE_TOKEN,
    (token, index) => fences[Number(index)] ?? token
  );
};

/**
 * Resolve `<Visibility>` blocks for agent-facing Markdown (llms-full.txt, the
 * `.md`/`.mdx` mirrors, MCP tools, Ask AI grounding): `for="web"` content is
 * removed and `for="agents"` content is unwrapped.
 */
export const applyAgentVisibility = (markdown: string): string =>
  applyAudienceVisibility(markdown, "agents");
