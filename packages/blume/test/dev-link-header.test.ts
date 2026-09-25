import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { dirname, join } from "pathe";

import { generateRuntime } from "../src/astro/generate.ts";
import {
  blumeIntegration,
  publishDevNegotiation,
} from "../src/astro/integration.ts";
import { astroConfigTemplate } from "../src/astro/templates.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";

/** The dev middleware's view of a request: the homepage, asked for HTML. */
interface DevRequest {
  headers: { accept?: string };
  method: string;
  url: string;
}

type Handle = (
  req: DevRequest,
  res: { setHeader: (name: string, value: string) => void },
  next: () => void
) => void;

/**
 * What a default-config site's dev server advertises: the JSON API's OpenAPI
 * document and the homepage's Markdown mirror, both routes it serves.
 */
const DEV_HEADER = [
  '</openapi.json>; rel="service-desc"; type="application/json"',
  '</index.md>; rel="alternate"; type="text/markdown"',
].join(", ");

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

// The negotiation inputs live on globalThis; don't leak them to other files.
afterEach(() => {
  publishDevNegotiation(null);
});

/** The `Link` header the dev middleware stamps on `GET /`. */
const homeLinkHeader = (): string | undefined => {
  const stack: { handle: Handle }[] = [];
  // SAFETY: the hook only touches the middleware stack and the fields
  // provided here.
  blumeIntegration({ pages: [] }).hooks["astro:server:setup"]?.({
    server: { environments: {}, middlewares: { stack } },
  } as never);
  const headers: Record<string, string> = {};
  stack[0]?.handle(
    { headers: {}, method: "GET", url: "/" },
    {
      setHeader: (name, value) => {
        headers[name] = value;
      },
    },
    () => {}
  );
  return headers.Link;
};

describe("the dev server's homepage Link header", () => {
  it("advertises only what the dev server serves", async () => {
    // llms.txt and agent-readability.json are on by default, but `blume
    // build` writes them into the build output: the dev server 404ed on
    // both while its header pointed agents at them.
    const root = await mkdtemp(join(tmpdir(), "blume-dev-link-"));
    dirs.push(root);
    const page = join(root, "docs", "index.md");
    await mkdir(dirname(page), { recursive: true });
    await writeFile(page, "# Home\n", "utf-8");
    const project = await scanProject(root, { mode: "dev" });
    expect(project.config.agents.llmsTxt.enabled).toBe(true);
    expect(project.config.agents.agentReadability).toBe(true);

    await generateRuntime(project);

    expect(homeLinkHeader()).toBe(DEV_HEADER);
  });

  it("bakes the same dev header into an ejected config", () => {
    const out = astroConfigTemplate({
      askPath: "./src/generated/Ask.astro",
      config: blumeConfigSchema.parse({}),
      contentRoutes: ["/"],
      context: {
        componentsFile: null,
        configFile: null,
        contentRoot: "/p/docs",
        outDir: "/p",
        pagesRoot: null,
        root: "/p",
        themeFile: null,
      },
      examplesPath: "./src/generated/examples.ts",
      examplesThemePath: "./src/generated/examples.css",
      featuresPath: "./src/generated/features.ts",
      generatedModulesDir: "./src/generated",
      needsReact: false,
      pages: [],
      searchClientPath: "./src/generated/search-client.ts",
      themePath: "./src/generated/app.css",
    });
    expect(out).toContain(`"homeLinkHeader":${JSON.stringify(DEV_HEADER)}`);
    expect(out).not.toContain("llms.txt");
  });
});
