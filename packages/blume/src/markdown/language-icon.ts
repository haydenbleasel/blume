/**
 * A Shiki transformer that prepends a brand icon to a code block's header,
 * keyed off the fence language. Icons are sourced from `simple-icons` (raw SVG
 * path data) at build time and emitted as an inline `<svg>` — no client JS and
 * no React, so it works in the core theme. The icon renders in `currentColor`
 * (the muted header color) so it stays legible in both light and dark; brand
 * hex colors are skipped because dark-on-dark logos (Next.js, Rust…) vanish.
 *
 * The theme styles `.blume-lang-icon` and shifts the language label
 * (`pre[data-icon]::before`) to make room.
 */

import {
  siAstro,
  siC,
  siCplusplus,
  siCss3,
  siDart,
  siDocker,
  siGnubash,
  siGo,
  siGraphql,
  siHtml5,
  siJavascript,
  siJson,
  siKotlin,
  siLess,
  siLua,
  siMarkdown,
  siMdx,
  siMysql,
  siNextdotjs,
  siPhp,
  siPrisma,
  siPython,
  siReact,
  siRuby,
  siRust,
  siSass,
  siScala,
  siSvelte,
  siSvg,
  siSwift,
  siToml,
  siTypescript,
  siVuedotjs,
  siWebassembly,
  siYaml,
} from "simple-icons";

/** The slice of a `simple-icons` icon Blume reads (the SVG path data). */
interface SimpleIcon {
  path: string;
}

/** Fence language (and common aliases) → icon. Unmapped languages get none. */
const LANGUAGE_ICONS: Record<string, SimpleIcon> = {
  astro: siAstro,
  bash: siGnubash,
  c: siC,
  "c++": siCplusplus,
  cjs: siJavascript,
  cpp: siCplusplus,
  css: siCss3,
  cts: siTypescript,
  dart: siDart,
  docker: siDocker,
  dockerfile: siDocker,
  go: siGo,
  gql: siGraphql,
  graphql: siGraphql,
  html: siHtml5,
  javascript: siJavascript,
  js: siJavascript,
  json: siJson,
  json5: siJson,
  jsonc: siJson,
  jsx: siReact,
  kotlin: siKotlin,
  kt: siKotlin,
  less: siLess,
  lua: siLua,
  markdown: siMarkdown,
  md: siMarkdown,
  mdx: siMdx,
  mjs: siJavascript,
  mts: siTypescript,
  nextjs: siNextdotjs,
  php: siPhp,
  prisma: siPrisma,
  py: siPython,
  python: siPython,
  rb: siRuby,
  react: siReact,
  rs: siRust,
  ruby: siRuby,
  rust: siRust,
  sass: siSass,
  scala: siScala,
  scss: siSass,
  sh: siGnubash,
  shell: siGnubash,
  sql: siMysql,
  svelte: siSvelte,
  svg: siSvg,
  swift: siSwift,
  toml: siToml,
  ts: siTypescript,
  tsx: siReact,
  typescript: siTypescript,
  vue: siVuedotjs,
  wasm: siWebassembly,
  yaml: siYaml,
  yml: siYaml,
  zsh: siGnubash,
};

/** A minimal hast node (avoids a hast type dependency). */
interface HastNode {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

/** The slice of Shiki's transformer `this` context the icon hook reads. */
interface IconContext {
  options: { lang?: string };
}

/** The `<pre>` hast node a Shiki `pre` hook receives. */
interface IconPreNode {
  children: HastNode[];
  properties: Record<string, boolean | number | string | undefined>;
}

/** A Shiki-compatible transformer, typed structurally to avoid a Shiki dep. */
export interface LanguageIconTransformer {
  name: string;
  pre: (this: IconContext, node: IconPreNode) => void;
}

/** Build an inline SVG hast node from a simple-icons path. */
const iconNode = (path: string): HastNode => ({
  children: [
    { children: [], properties: { d: path }, tagName: "path", type: "element" },
  ],
  properties: {
    ariaHidden: "true",
    className: ["blume-lang-icon"],
    fill: "currentColor",
    height: 14,
    viewBox: "0 0 24 24",
    width: 14,
  },
  tagName: "svg",
  type: "element",
});

/** Build the transformer. Runs after Shiki's built-in `data-language` hook. */
export const languageIconTransformer = (): LanguageIconTransformer => ({
  name: "blume:language-icon",
  pre(node) {
    const icon = LANGUAGE_ICONS[(this.options.lang ?? "").toLowerCase()];
    if (!icon) {
      return;
    }
    node.children.unshift(iconNode(icon.path));
    node.properties.dataIcon = "";
  },
});
