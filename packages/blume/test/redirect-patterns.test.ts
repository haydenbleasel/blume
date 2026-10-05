import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { astroConfigTemplate } from "../src/astro/templates.ts";
import { validateLinks } from "../src/core/links.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import {
  compileEveryRedirect,
  compileRedirects,
  encodeCapture,
  exactFirst,
  expandRedirect,
  isPatternPath,
  matchCompiledRedirect,
  pathsUnderPattern,
  patternDestination,
  redirectPatternError,
  regexRedirect,
  requestPath,
  underscoreRedirect,
  vercelRedirect,
} from "../src/core/redirect-patterns.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { BlumeConfigInput } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";
import { netlify, vercel } from "../src/deploy/adapters/index.ts";
import { escapeVercelSource } from "../src/deploy/headers.ts";
import {
  emitNetlifyPatternRedirects,
  NETLIFY_CONFIG_FILE,
} from "../src/deploy/platforms/netlify.ts";
import type { BuildLog } from "../src/deploy/platforms/types.ts";
import { emitVercelPatternRedirects } from "../src/deploy/platforms/vercel.ts";
import {
  buildNetlifyRedirects,
  buildRedirectManifest,
  buildVercelConfig,
  netlifyPatternRedirects,
  vercelPatternRoutes,
} from "../src/deploy/redirects.ts";
import { injectRedirectRoutes } from "../src/deploy/vercel-negotiation.ts";

/**
 * Pattern redirects (`src/core/redirect-patterns.ts`): `/beta/:slug*`,
 * `/old/:id`, and `/old/article-*` parsed once and written in each host's
 * syntax, matched by the servers and the dev server, and checked against the
 * site's own pages and links.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const scratch = async (files: Record<string, string> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-redirect-patterns-"));
  dirs.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    })
  );
  return root;
};

const BETA = { from: "/beta/:slug*", status: 301, to: "/v2/:slug*" } as const;
const ONE = { from: "/old/:id/edit", status: 302, to: "/new/:id" } as const;
const ARTICLE = {
  from: "/old/article-*",
  status: 308,
  to: "/new/article-*",
} as const;
const SPLAT = {
  from: "/legacy/*",
  status: 301,
  to: "/:splat?from=legacy",
} as const;

/** Why a `from` can't work, with a `to` that reads nothing. */
const fromError = (from: string) => redirectPatternError(from, "/")?.message;

describe("parsing and validation", () => {
  it("tells a pattern from an exact path", () => {
    expect(isPatternPath("/beta/:slug*")).toBe(true);
    expect(isPatternPath("/old/*")).toBe(true);
    expect(isPatternPath("/a:b")).toBe(false);
    expect(isPatternPath("/")).toBe(false);
    // Malformed pattern syntax is still pattern syntax.
    expect(isPatternPath("/a/*/b")).toBe(true);
  });

  it("names what's wrong with a `from`", () => {
    expect(fromError("/a/:splat")).toContain("`:splat` is the name `*`");
    expect(fromError("/a/:b/:b")).toContain("`:b` appears twice");
    expect(fromError("/a/:b*/c")).toContain("must be the last segment");
    expect(fromError("/a/:b.json")).toContain("isn't a whole-segment");
    expect(fromError("/a/*/b")).toContain("can only end it");
    expect(fromError("/a/b*c")).toContain("can only end it");
    expect(redirectPatternError("/a/:b*/c", "/")?.end).toBe("from");
  });

  it("names a capture `to` reads that `from` doesn't make", () => {
    expect(redirectPatternError("/a", "/b/:x")).toStrictEqual({
      end: "to",
      message: "`to` reads `:x`, which `from` doesn't capture.",
    });
    expect(redirectPatternError("/a/:x", "/b/*")?.message).toBe(
      "`to` reads `*`, which `from` doesn't capture."
    );
    for (const redirect of [BETA, ONE, ARTICLE, SPLAT]) {
      expect(redirectPatternError(redirect.from, redirect.to)).toBeNull();
    }
  });

  it("puts exact redirects ahead of patterns", () => {
    const exact = { from: "/beta/pinned", status: 301, to: "/pinned" };
    expect(exactFirst([BETA, exact])).toStrictEqual([exact, BETA]);
  });
});

describe(expandRedirect, () => {
  it("splits a rest into the bare path and one or more segments", () => {
    const rules = expandRedirect(BETA);
    expect(rules.map((rule) => underscoreRedirect(rule))).toStrictEqual([
      { from: "/beta", to: "/v2" },
      { from: "/beta/*", to: "/v2/:splat" },
    ]);
    // A root rest's bare rule is the root, and a destination query survives.
    expect(
      expandRedirect({ from: "/:slug*", status: 301, to: "/:slug*?x=1" }).map(
        (rule) => underscoreRedirect(rule)
      )
    ).toStrictEqual([
      { from: "/", to: "/?x=1" },
      { from: "/*", to: "/:splat?x=1" },
    ]);
  });

  it("keeps other captures in the bare rule, and has no rules for an exact or malformed `from`", () => {
    expect(
      expandRedirect({
        from: "/v/:version/:slug*",
        status: 301,
        to: "/docs/:version/:slug*",
      }).map((rule) => underscoreRedirect(rule))
    ).toStrictEqual([
      { from: "/v/:version", to: "/docs/:version" },
      { from: "/v/:version/*", to: "/docs/:version/:splat" },
    ]);
    expect(expandRedirect({ from: "/old", status: 301, to: "/new" })).toEqual(
      []
    );
    expect(expandRedirect({ from: "/a/*/b", status: 301, to: "/" })).toEqual(
      []
    );
  });
});

describe("host formats", () => {
  const rules = [BETA, ONE, ARTICLE, SPLAT].flatMap(expandRedirect);

  it("writes `_redirects` placeholders and splats", () => {
    expect(rules.map((rule) => underscoreRedirect(rule))).toStrictEqual([
      { from: "/beta", to: "/v2" },
      { from: "/beta/*", to: "/v2/:splat" },
      { from: "/old/:id/edit", to: "/new/:id" },
      { from: "/old/article-*", to: "/new/article-:splat" },
      { from: "/legacy", to: "/?from=legacy" },
      { from: "/legacy/*", to: "/:splat?from=legacy" },
    ]);
  });

  it("writes `path-to-regexp` sources, their literal runs escaped", () => {
    expect(
      [
        ...rules,
        ...expandRedirect({
          from: "/c++/:slug*",
          status: 301,
          to: "/c/:slug*",
        }),
      ].map((rule) => vercelRedirect(rule, escapeVercelSource))
    ).toStrictEqual([
      { destination: "/v2", source: "/beta" },
      { destination: "/v2/:slug+", source: "/beta/:slug+" },
      { destination: "/new/:id", source: "/old/:id/edit" },
      {
        destination: "/new/article-:splat",
        source: "/old/article-:splat(.*)",
      },
      { destination: "/?from=legacy", source: "/legacy" },
      { destination: "/:splat+?from=legacy", source: "/legacy/:splat+" },
      { destination: "/c", source: "/c\\+\\+" },
      { destination: "/c/:slug+", source: "/c\\+\\+/:slug+" },
    ]);
  });

  it("writes regular expressions over the decoded path, a trailing slash optional", () => {
    expect(rules.map((rule) => regexRedirect(rule))).toStrictEqual([
      { location: "/v2", source: "^/beta/?$" },
      { location: "/v2/$1", source: "^/beta/(.+?)/?$" },
      { location: "/new/$1", source: "^/old/([^/]+)/edit/?$" },
      { location: "/new/article-$1", source: "^/old/article-(.*?)/?$" },
      { location: "/?from=legacy", source: "^/legacy/?$" },
      { location: "/$1?from=legacy", source: "^/legacy/(.+?)/?$" },
    ]);
    const [root] = expandRedirect({ from: "/:slug*", status: 301, to: "/" });
    expect(root && regexRedirect(root).source).toBe("^/$");
    // A trailing slash on the pattern itself is optional too.
    const [slashed] = expandRedirect({ from: "/a/:id/", status: 301, to: "/" });
    expect(slashed && regexRedirect(slashed).source).toBe("^/a/([^/]+)/?$");
  });
});

describe("matching", () => {
  const compiled = compileRedirects([BETA, ONE, ARTICLE]);

  it("answers the first rule a decoded path matches, its captures encoded", () => {
    expect(matchCompiledRedirect(compiled, "/beta")).toStrictEqual([
      "/v2",
      301,
    ]);
    expect(matchCompiledRedirect(compiled, "/beta/a b/ü#?")).toStrictEqual([
      "/v2/a%20b/%C3%BC%23%3F",
      301,
    ]);
    expect(matchCompiledRedirect(compiled, "/old/7/edit/")).toStrictEqual([
      "/new/7",
      302,
    ]);
    expect(matchCompiledRedirect(compiled, "/old/7")).toBeNull();
    expect(encodeCapture("a?b#c")).toBe("a%3Fb%23c");
  });

  it("compiles exact redirects too for the dev server, ahead of patterns", () => {
    const every = compileEveryRedirect([
      BETA,
      { from: "/beta/a.b/", status: 307, to: "/ü" },
      { from: "/", status: 302, to: "/start" },
    ]);
    expect(every.slice(0, 2)).toStrictEqual([
      [String.raw`^/beta/a\.b/?$`, "/%C3%BC", 307],
      ["^/$", "/start", 302],
    ]);
    expect(every.slice(2)).toStrictEqual(compileRedirects([BETA]));
    expect(matchCompiledRedirect(every, "/beta/a.b/")).toStrictEqual([
      "/%C3%BC",
      307,
    ]);
    expect(matchCompiledRedirect(every, "/beta/axb")).toStrictEqual([
      "/v2/axb",
      301,
    ]);
  });

  it("reads a request URL's decoded path, keeping a malformed escape", () => {
    expect(requestPath("/beta/%C3%BC?x=1#y")).toBe("/beta/ü");
    expect(requestPath("/beta/%E0%A4%A")).toBe("/beta/%E0%A4%A");
  });

  it("follows a path to its unencoded destination, and lists the paths a pattern covers", () => {
    expect(patternDestination([BETA, ARTICLE], "/old/article-ü")).toBe(
      "/new/article-ü"
    );
    expect(patternDestination([BETA], "/elsewhere")).toBeUndefined();
    expect(
      pathsUnderPattern("/beta/:slug*", ["/beta", "/beta/a", "/betas", "/"])
    ).toStrictEqual(["/beta", "/beta/a"]);
    expect(pathsUnderPattern("/beta", ["/beta"])).toStrictEqual([]);
  });
});

describe("the host files", () => {
  const exact = { from: "/gone", status: 302, to: "/here" } as const;

  it("write each host's syntax, exact redirects as they are", () => {
    expect(buildNetlifyRedirects([exact, BETA])).toBe(
      "/gone /here 302\n/beta /v2 301\n/beta/* /v2/:splat 301\n"
    );
    expect(buildNetlifyRedirects([BETA], true)).toBe(
      "/beta /v2 301!\n/beta/* /v2/:splat 301!\n"
    );
    expect(JSON.parse(buildVercelConfig([exact, ARTICLE])).redirects).toEqual([
      { destination: "/here", source: "/gone", statusCode: 302 },
      {
        destination: "/new/article-:splat",
        source: "/old/article-:splat(.*)",
        statusCode: 308,
      },
    ]);
    // The manifest keeps a pattern as configured, for hand-written rules.
    expect(JSON.parse(buildRedirectManifest([BETA]))).toEqual([BETA]);
  });

  it("give a Netlify server build `_redirects` entries and a Vercel one routes", () => {
    expect(netlifyPatternRedirects([exact, ONE])).toStrictEqual([
      { from: "/old/:id/edit", status: 302, to: "/new/:id" },
    ]);
    expect(vercelPatternRoutes([exact, BETA])).toStrictEqual([
      { headers: { Location: "/v2" }, src: "^/beta/?$", status: 301 },
      { headers: { Location: "/v2/$1" }, src: "^/beta/(.+?)/?$", status: 301 },
    ]);
  });
});

describe(injectRedirectRoutes, () => {
  const ROUTES = vercelPatternRoutes([BETA]);
  const CONFIG = JSON.stringify({
    routes: [
      { headers: { Location: "/new" }, src: "^/old$", status: 301 },
      { handle: "filesystem" },
      { dest: "_render", src: "/.*" },
    ],
    version: 3,
  });

  it("splices the routes after the exact redirects, ahead of the filesystem, once", () => {
    const once = injectRedirectRoutes(CONFIG, ROUTES);
    const twice = injectRedirectRoutes(once ?? "", ROUTES);
    expect(twice).toBe(once);
    expect(JSON.parse(twice ?? "").routes).toEqual([
      { headers: { Location: "/new" }, src: "^/old$", status: 301 },
      ...ROUTES,
      { handle: "filesystem" },
      { dest: "_render", src: "/.*" },
    ]);
  });

  it("refuses a config it can't splice into", () => {
    expect(injectRedirectRoutes("{", ROUTES)).toBeNull();
    expect(injectRedirectRoutes("{}", ROUTES)).toBeNull();
    expect(injectRedirectRoutes('{"routes":[]}', ROUTES)).toBeNull();
  });
});

/** A project with a config and routes, and the log a finalize step writes to. */
interface FinalizeFixture {
  log: BuildLog;
  project: BlumeProject;
  warnings: string[];
}

const projectAt = (root: string, input: BlumeConfigInput): FinalizeFixture => {
  const warnings: string[] = [];
  return {
    log: {
      error: () => {},
      info: () => {},
      success: () => {},
      warn: (message) => warnings.push(message),
    },
    // SAFETY: the finalize steps read only `config`, `context.root`, and
    // `manifest.routes[].path`.
    project: {
      config: blumeConfigSchema.parse(input),
      context: { root },
      manifest: { routes: [{ path: "/" }] },
    } as BlumeProject,
    warnings,
  };
};

describe(emitVercelPatternRedirects, () => {
  const VERCEL_CONFIG = join(".vercel", "output", "config.json");

  it("routes the patterns in the Build Output config", async () => {
    const root = await scratch({
      [VERCEL_CONFIG]: JSON.stringify({ routes: [{ handle: "filesystem" }] }),
    });
    const { log, project } = projectAt(root, {
      deployment: vercel(),
      redirects: [BETA],
    });
    await emitVercelPatternRedirects(project, log);
    const config = JSON.parse(
      await readFile(join(root, VERCEL_CONFIG), "utf-8")
    );
    expect(config.routes.at(0)).toEqual({
      headers: { Location: "/v2" },
      src: "^/beta/?$",
      status: 301,
    });
  });

  it("warns when the config has nowhere to splice, and skips a site without patterns or a config", async () => {
    const root = await scratch({ [VERCEL_CONFIG]: "{}" });
    const { log, project, warnings } = projectAt(root, {
      deployment: vercel(),
      redirects: [BETA],
    });
    await emitVercelPatternRedirects(project, log);
    expect(warnings).toHaveLength(1);
    const none = projectAt(root, { deployment: vercel() });
    await emitVercelPatternRedirects(none.project, none.log);
    const missing = projectAt(await scratch(), {
      deployment: vercel(),
      redirects: [BETA],
    });
    await emitVercelPatternRedirects(missing.project, missing.log);
    expect([...none.warnings, ...missing.warnings]).toEqual([]);
    expect(await readFile(join(root, VERCEL_CONFIG), "utf-8")).toBe("{}");
  });
});

describe(emitNetlifyPatternRedirects, () => {
  it("adds the patterns to the Frameworks API config's redirects, once", async () => {
    const root = await scratch({
      [NETLIFY_CONFIG_FILE]: JSON.stringify({
        headers: [],
        redirects: [{ from: "/mine", to: "/yours" }],
      }),
    });
    const { project } = projectAt(root, {
      deployment: netlify(),
      redirects: [{ from: "/exact", to: "/x" }, ONE],
    });
    await emitNetlifyPatternRedirects(project);
    await emitNetlifyPatternRedirects(project);
    expect(
      JSON.parse(await readFile(join(root, NETLIFY_CONFIG_FILE), "utf-8"))
    ).toEqual({
      headers: [],
      redirects: [
        { from: "/mine", to: "/yours" },
        { from: "/old/:id/edit", status: 302, to: "/new/:id" },
      ],
    });
  });

  it("does nothing without patterns or a config", async () => {
    const root = await scratch({ [NETLIFY_CONFIG_FILE]: "{}" });
    await emitNetlifyPatternRedirects(
      projectAt(root, { deployment: netlify() }).project
    );
    await emitNetlifyPatternRedirects(
      projectAt(await scratch(), { deployment: netlify(), redirects: [ONE] })
        .project
    );
    expect(await readFile(join(root, NETLIFY_CONFIG_FILE), "utf-8")).toBe("{}");
  });
});

describe("the generated Astro config", () => {
  const context: ProjectContext = {
    componentsFile: null,
    configFile: null,
    contentRoot: "/p/docs",
    outDir: "/p/.blume",
    pagesRoot: null,
    root: "/p",
    themeFile: null,
  };
  const configFor = (
    input: BlumeConfigInput,
    contentRoutes: string[] = []
  ): string =>
    astroConfigTemplate({
      askPath: "/p/.blume/src/generated/Ask.astro",
      config: blumeConfigSchema.parse(input),
      consentClientPath: "/p/.blume/src/generated/consent-client.ts",
      contentRoutes,
      context,
      examplesPath: "/p/.blume/src/generated/examples.ts",
      examplesThemePath: "/p/.blume/src/generated/examples.css",
      features: { epub: false, mermaid: false },
      featuresPath: "/p/.blume/src/generated/features.ts",
      needsReact: false,
      pages: [],
      searchClientPath: "/p/.blume/src/generated/search-client.ts",
      themePath: "/p/.blume/src/generated/app.css",
    });

  it("gives Astro the exact redirects and the dev server every one", () => {
    const generated = configFor({
      basePath: "/docs",
      redirects: [BETA, { from: "/old", status: 302, to: "/new" }],
    });
    expect(generated).toContain(
      'redirects: {"/docs/old":{"destination":"/docs/new","status":302}}'
    );
    // Astro's dev handler would answer the exact one with a 301.
    expect(generated).toContain(
      '"redirects":[["^/docs/old/?$","/docs/new",302],["^/docs/beta/?$","/docs/v2",301],["^/docs/beta/(.+?)/?$","/docs/v2/$1",301]]'
    );
    expect(configFor({})).not.toContain('"redirects":[');
  });

  it("moves a moved page's Markdown copies with it", () => {
    const generated = configFor(
      {
        basePath: "/docs",
        deployment: vercel({ base: "/base" }),
        redirects: [{ from: "/old", status: 307, to: "/new" }],
      },
      ["/docs/new"]
    );
    expect(generated).toContain(
      'redirects: {"/docs/old":{"destination":"/base/docs/new","status":307},"/docs/old.md":{"destination":"/base/docs/new.md","status":307},"/docs/old.mdx":{"destination":"/base/docs/new.mdx","status":307}}'
    );
    expect(generated).toContain(
      '"redirects":[["^/docs/old/?$","/base/docs/new",307],["^/docs/old\\\\.md/?$","/base/docs/new.md",307],["^/docs/old\\\\.mdx/?$","/base/docs/new.mdx",307]]'
    );
  });
});

describe("the scan", () => {
  it("fails a pattern that also matches a page, and passes one that doesn't", async () => {
    const root = await scratch({
      "blume.config.ts": `export default ${JSON.stringify({
        redirects: [
          { from: "/guides/:slug*", to: "/tutorials/:slug*" },
          { from: "/beta/:slug*", to: "/guides/:slug*" },
          { from: "/:page", to: "/guides/:page" },
        ],
      })};\n`,
      "docs/guides/a.md": "---\ntitle: A\n---\n\nA.\n",
      "docs/guides/b.md": "---\ntitle: B\n---\n\nB.\n",
      "docs/index.md": "---\ntitle: Home\n---\n\nSee [beta](/beta/a).\n",
      "docs/intro.md": "---\ntitle: Intro\n---\n\nIntro.\n",
    });
    const scanned = await scanProject(root, { mode: "build" });
    const conflicts = scanned.diagnostics.filter(
      (diagnostic) => diagnostic.code === "BLUME_REDIRECT_MATCHES_PAGE"
    );
    expect(conflicts.map((diagnostic) => diagnostic.message)).toEqual([
      "The redirect from /guides/:slug* also matches the page /guides/a and 1 more, which some hosts would redirect and others would serve.",
      "The redirect from /:page also matches the page /intro, which some hosts would redirect and others would serve.",
    ]);
    expect(conflicts[0]?.file).toBe(join(root, "blume.config.ts"));

    // An exact redirect shadows its page on every host: a warning.
    const shadowed = await scanProject(
      await scratch({
        "blume.config.ts": `export default ${JSON.stringify({
          redirects: [
            { from: "/intro/", to: "/" },
            { from: "/gone", to: "/" },
          ],
        })};\n`,
        "docs/index.md": "---\ntitle: Home\n---\n\nHome.\n",
        "docs/intro.md": "---\ntitle: Intro\n---\n\nIntro.\n",
      }),
      { mode: "build" }
    );
    expect(
      shadowed.diagnostics
        .filter(
          (diagnostic) => diagnostic.code === "BLUME_REDIRECT_MATCHES_PAGE"
        )
        .map((diagnostic) => [diagnostic.severity, diagnostic.message])
    ).toEqual([
      [
        "warning",
        "The redirect from /intro/ is also the page /intro, which never publishes: its URL redirects to / instead.",
      ],
    ]);

    // A link into a pattern is a valid target, like one to an exact `from`.
    const links = await validateLinks(scanned.graph, {
      publicDir: null,
      redirects: scanned.config.redirects,
    });
    expect(links).toEqual([]);
  });
});
