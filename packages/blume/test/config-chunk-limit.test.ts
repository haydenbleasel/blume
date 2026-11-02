import { describe, expect, it } from "bun:test";

import { astroConfigTemplate } from "../src/astro/templates.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";

const context: ProjectContext = {
  componentsFile: null,
  configFile: null,
  contentRoot: "/p/docs",
  outDir: "/p/.blume",
  pagesRoot: null,
  root: "/p",
  themeFile: null,
};

const configFor = (mermaid: boolean): string =>
  astroConfigTemplate({
    askPath: "/p/.blume/src/generated/Ask.astro",
    config: blumeConfigSchema.parse({}),
    consentClientPath: "/p/.blume/src/generated/consent-client.ts",
    contentRoutes: [],
    context,
    examplesPath: "/p/.blume/src/generated/examples.ts",
    examplesThemePath: "/p/.blume/src/generated/examples.css",
    features: { epub: false, mermaid },
    featuresPath: "/p/.blume/src/generated/features.ts",
    needsReact: false,
    pages: [],
    searchClientPath: "/p/.blume/src/generated/search-client.ts",
    themePath: "/p/.blume/src/generated/app.css",
  });

describe("the chunk-size warning limit", () => {
  it("rises above Pele's lazy chunk on a site with diagrams", () => {
    expect(configFor(true)).toContain("chunkSizeWarningLimit: 1024,");
  });

  it("stays at Vite's default everywhere else", () => {
    expect(configFor(false)).not.toContain("chunkSizeWarningLimit");
  });
});
