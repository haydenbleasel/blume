import { unescape } from "html-escaper";

import type { SearchFn } from "../layout/search/types.ts";
import {
  isRootRelative,
  joinBase,
  mountBase,
  prefixBase,
} from "./base-path.ts";

/**
 * WebMCP (W3C Web Machine Learning CG): in-page tools an agentic browser can
 * call, registered on the page's model context. Blume exposes the same
 * read-only surface its hosted MCP server has — search, page Markdown, the
 * docs index — plus the site's agent skills and same-origin navigation, so
 * an agent driving the browser needs no separate connection.
 * The module is inert everywhere else: registration is attempted only when
 * the page exposes a model context.
 */

/** MCP-style tool result: text content, with `isError` on failures. */
interface WebMcpResult {
  content: { text: string; type: "text" }[];
  isError?: boolean;
}

/** A JSON value as a WebMCP agent may supply it in a tool call. */
export type WebMcpJsonValue =
  | boolean
  | number
  | string
  | null
  | WebMcpJsonValue[]
  | { [key: string]: WebMcpJsonValue };

/**
 * Tool arguments exactly as the calling agent supplied them. WebMCP doesn't
 * guarantee schema validation, so each tool checks its own fields at runtime.
 */
export interface WebMcpToolArgs {
  name?: WebMcpJsonValue;
  query?: WebMcpJsonValue;
  route?: WebMcpJsonValue;
}

/** The JSON Schema subset these string-argument tools declare. */
export interface WebMcpInputSchema {
  properties: Record<string, { description: string; type: "string" }>;
  required?: string[];
  type: "object";
}

export interface WebMcpTool {
  annotations: { openWorldHint: boolean; readOnlyHint: boolean };
  description: string;
  execute: (input: WebMcpToolArgs) => Promise<WebMcpResult>;
  inputSchema: WebMcpInputSchema;
  name: string;
}

/**
 * The registration surface, in either of the shapes the moving spec has
 * shipped: Chrome's early preview exposes `navigator.modelContext` with
 * `provideContext({ tools })`, while the editor's draft registers tools
 * individually via `registerTool`.
 */
export interface ModelContext {
  provideContext?: (context: { tools: WebMcpTool[] }) => void;
  registerTool?: (tool: WebMcpTool) => void;
}

const text = (value: string, isError = false): WebMcpResult => {
  const result: WebMcpResult = { content: [{ text: value, type: "text" }] };
  if (isError) {
    result.isError = true;
  }
  return result;
};

/** Validates an agent-supplied tool argument before it is used as a string. */
const isString = (value: WebMcpJsonValue | undefined): value is string =>
  typeof value === "string";

/** Detects which registration surface a model context actually implements. */
const isCallable = <T extends (...args: never[]) => void>(
  value: T | undefined
): value is T => typeof value === "function";

/** A JSON object as an agent or the skills index may supply it. */
const isJsonObject = (
  value: WebMcpJsonValue | undefined
): value is { [key: string]: WebMcpJsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One entry of the Agent Skills discovery index (`index.json`). */
interface SkillsIndexEntry {
  description: string;
  /** `sha256:{hex}` of the artifact, when the index publishes one. */
  digest: string | undefined;
  name: string;
  type: "archive" | "skill-md";
  /** The artifact, resolved against the index; always on the index's origin. */
  url: URL;
}

/**
 * An index entry the tool can hand over, or null to skip it: a string `name`,
 * a `type` the discovery RFC defines, and a `url` that resolves (against the
 * index, as the RFC specifies) to this site. Every listed skill is readable,
 * and the tool never fetches off-site.
 */
const toSkillEntry = (
  value: WebMcpJsonValue,
  index: URL
): SkillsIndexEntry | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  const { description, digest, name, type, url } = value;
  if (
    !(isString(name) && isString(url)) ||
    (type !== "archive" && type !== "skill-md")
  ) {
    return null;
  }
  const resolved = URL.parse(url, index);
  if (resolved?.origin !== index.origin) {
    return null;
  }
  return {
    description: isString(description) ? description : "",
    digest: isString(digest) ? digest : undefined,
    name,
    type,
    url: resolved,
  };
};

const TAG = /<[^>]*>?/gu;

/**
 * Search-hit HTML as the plain text an agent reads: the `<mark>`
 * highlighting (and any other markup) dropped, then the entities the
 * highlighter escaped decoded (`&lt;T&gt; &amp;` → `<T> &`). The closing `>`
 * is optional so every `<` starts a strip: a dangling `<script` fragment
 * can't survive the way it would if a full `<...>` pair were required. The
 * input is HTML, where a literal `<` is `&lt;`, so consuming from every raw
 * `<` loses nothing legitimate. Stripping repeats to a fixed point so the
 * no-fragment guarantee is explicit rather than an artifact of the regex
 * shape; decoding comes last, so a decoded `<` is text, never a tag.
 */
const plain = (html: string): string => {
  let stripped = html;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replaceAll(TAG, "");
  } while (stripped !== previous);
  return unescape(stripped);
};

export interface WebMcpToolOptions {
  /** The deployment base (`import.meta.env.BASE_URL`). */
  base: string;
  /** Injectable for tests; defaults to the page's `fetch`. */
  fetchFn?: typeof fetch;
  /** Lazy provider-specific search loader (`blume:search-client`). */
  loadSearch: () => Promise<SearchFn>;
  /** Whether the site publishes llms.txt (gates the list tool). */
  llms: boolean;
  /**
   * Opens a URL in the reader's tab. The page passes the client router's
   * `navigate`; defaults to `location.assign` (and is injectable for tests).
   */
  navigate?: (url: string) => void;
  /**
   * The page's origin, which skill artifacts must share. Injectable for
   * tests; defaults to `location.origin`.
   */
  origin?: string;
  /** Whether site search is configured (gates the search tool). */
  search: boolean;
  /** Whether the site serves a skills discovery index (gates `read_skill`). */
  skills: boolean;
}

/** Build the tool set. Pure — registration is the caller's business. */
export const buildWebMcpTools = (options: WebMcpToolOptions): WebMcpTool[] => {
  const fetchFn = options.fetchFn ?? fetch;
  const readOnly = { openWorldHint: false, readOnlyHint: true };
  const tools: WebMcpTool[] = [];

  if (options.search) {
    // One search instance per page; a transient load failure retries on the
    // next call rather than latching broken.
    let searchFn: SearchFn | null = null;
    tools.push({
      annotations: readOnly,
      description:
        "Full-text search across this documentation site. Returns matching pages with their title, URL, and a short excerpt.",
      async execute(input) {
        const query = isString(input.query) ? input.query : "";
        if (!query.trim()) {
          return text("Provide a non-empty `query` string.", true);
        }
        try {
          searchFn ??= await options.loadSearch();
          const { hits } = await searchFn(query);
          if (hits.length === 0) {
            return text(`No results for "${query}".`);
          }
          return text(
            hits
              .map(
                (hit) =>
                  `${plain(hit.title)} — ${mountBase(options.base, hit.url)}\n${plain(hit.excerpt)}`
              )
              .join("\n\n")
          );
        } catch {
          searchFn = null;
          return text("Search is unavailable right now.", true);
        }
      },
      inputSchema: {
        properties: {
          query: { description: "The search query.", type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search_docs",
    });
  }

  tools.push({
    annotations: readOnly,
    description:
      "Fetch a page of this site as plain Markdown. Pass the page's root-relative route, e.g. `/quickstart`.",
    async execute(input) {
      const route = isString(input.route) ? input.route : "";
      if (!isRootRelative(route)) {
        return text("Pass a root-relative route, e.g. `/quickstart`.", true);
      }
      const trimmed = route.length > 1 ? route.replace(/\/+$/u, "") : route;
      const target = trimmed === "/" ? "/index" : trimmed;
      // The agent may hand back a served URL `search_docs` returned, base
      // included, so a path already under the base keeps it (`prefixBase`).
      const response = await fetchFn(
        `${prefixBase(options.base, target)}.md`
      ).catch(() => null);
      if (!response?.ok) {
        return text(`No Markdown found for ${route}.`, true);
      }
      return text(await response.text());
    },
    inputSchema: {
      properties: {
        route: {
          description: "Root-relative page route, e.g. `/quickstart`.",
          type: "string",
        },
      },
      required: ["route"],
      type: "object",
    },
    name: "get_page",
  });

  if (options.llms) {
    tools.push({
      annotations: readOnly,
      description:
        "List this site's pages: the llms.txt index of every page with its URL and summary, organized by section.",
      async execute() {
        const response = await fetchFn(
          joinBase(options.base, "llms.txt")
        ).catch(() => null);
        if (!response?.ok) {
          return text("The page index (llms.txt) is unavailable.", true);
        }
        return text(await response.text());
      },
      inputSchema: { properties: {}, type: "object" },
      name: "list_pages",
    });
  }

  if (options.skills) {
    const index = new URL(
      joinBase(options.base, ".well-known/agent-skills/index.json"),
      options.origin ?? window.location.origin
    );
    /** The published skills, or null when the index is missing or malformed. */
    const fetchSkills = async (): Promise<SkillsIndexEntry[] | null> => {
      try {
        const response = await fetchFn(index.pathname);
        if (!response.ok) {
          return null;
        }
        // SAFETY: parsed JSON is always a WebMcpJsonValue; its shape is
        // checked field by field below.
        const body = (await response.json()) as WebMcpJsonValue;
        const skills = isJsonObject(body) ? body.skills : undefined;
        return Array.isArray(skills)
          ? skills.flatMap((entry) => toSkillEntry(entry, index) ?? [])
          : null;
      } catch {
        return null;
      }
    };
    // One index fetch per page; a failed one retries on the next call rather
    // than latching "no skills".
    let skillsIndex: Promise<SkillsIndexEntry[] | null> | null = null;
    const loadSkills = async (): Promise<SkillsIndexEntry[]> => {
      skillsIndex ??= fetchSkills();
      const skills = await skillsIndex;
      if (skills === null) {
        skillsIndex = null;
      }
      return skills ?? [];
    };
    tools.push({
      annotations: readOnly,
      description:
        "Read one of this site's agent skills as Markdown. Omit `name` to list the available skills with their descriptions.",
      async execute(input) {
        const skills = await loadSkills();
        if (skills.length === 0) {
          return text("This site publishes no agent skills.", true);
        }
        const name = isString(input.name) ? input.name.trim() : "";
        if (!name) {
          return text(
            skills
              .map((skill) =>
                skill.description
                  ? `${skill.name} — ${skill.description}`
                  : skill.name
              )
              .join("\n")
          );
        }
        const skill = skills.find((entry) => entry.name === name);
        if (!skill) {
          return text(
            `No skill named "${name}". Available: ${skills.map((entry) => entry.name).join(", ")}.`,
            true
          );
        }
        if (skill.type === "archive") {
          // Skills with supporting files ship as a .tar.gz the agent must
          // download and unpack; there's no single Markdown file to return.
          const digest = skill.digest ? ` Its digest is ${skill.digest}.` : "";
          return text(
            `"${name}" is an archive skill: download ${skill.url.href} and unpack it.${digest}`
          );
        }
        const response = await fetchFn(
          `${skill.url.pathname}${skill.url.search}`
        ).catch(() => null);
        if (!response?.ok) {
          return text(`The "${name}" skill is unavailable.`, true);
        }
        return text(await response.text());
      },
      inputSchema: {
        properties: {
          name: {
            description: "The skill's name. Omit to list available skills.",
            type: "string",
          },
        },
        type: "object",
      },
      name: "read_skill",
    });
  }

  const navigate =
    options.navigate ?? ((url: string) => window.location.assign(url));
  tools.push({
    // Not read-only: it moves the user's tab, though never off-site.
    annotations: { openWorldHint: false, readOnlyHint: false },
    description:
      "Open a page of this site in the current browser tab. Pass the page's path as `search_docs` returns it, e.g. `/quickstart`, optionally with a `#heading` fragment.",
    execute(input) {
      const route = isString(input.route) ? input.route : "";
      if (!isRootRelative(route)) {
        return Promise.resolve(
          text("Pass a root-relative route, e.g. `/quickstart`.", true)
        );
      }
      // Like `get_page`, a path already under the base (the served URL
      // `search_docs` returns) keeps it.
      const url = prefixBase(options.base, route);
      // Navigate once the result is handed back, so the host receives it
      // before the page starts to unload.
      setTimeout(() => navigate(url), 0);
      return Promise.resolve(text(`Navigating to ${url}.`));
    },
    inputSchema: {
      properties: {
        route: {
          description:
            "The page's path as `search_docs` returns it, e.g. `/quickstart`.",
          type: "string",
        },
      },
      required: ["route"],
      type: "object",
    },
    name: "navigate_page",
  });

  return tools;
};

/**
 * Register the tools on whichever model context the page exposes. Returns
 * whether a registration surface was found — false in every browser that
 * doesn't implement WebMCP, which is the common, silent case.
 */
export const registerWebMcpTools = (
  tools: WebMcpTool[],
  context?: ModelContext | null
): boolean => {
  if (!context) {
    return false;
  }
  if (isCallable(context.provideContext)) {
    context.provideContext({ tools });
    return true;
  }
  if (isCallable(context.registerTool)) {
    for (const tool of tools) {
      context.registerTool(tool);
    }
    return true;
  }
  return false;
};
