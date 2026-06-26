import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { join } from "pathe";
import { describe, expect, it, vi } from "vitest";

import { buildLlmsFiles, writeLlmsArtifacts } from "../src/ai/llms.ts";
import { buildPageMarkdown } from "../src/ai/markdown.ts";
import {
  buildRuntimeMarkdown,
  generateRuntime,
} from "../src/astro/generate.ts";
import {
  astroConfigTemplate,
  catchAllPageTemplate,
  contentConfigTemplate,
} from "../src/astro/templates.ts";
import { generateAsyncApiDocs, parseAsyncApi } from "../src/asyncapi/import.ts";
import {
  buildChangelogRssFeeds,
  writeChangelogRssFeeds,
} from "../src/changelog/rss.ts";
import {
  findBreadcrumbs,
  findDirectoryListing,
  flattenPages,
  getPagination,
} from "../src/components/layout/nav-utils.ts";
import { loadConfig } from "../src/core/config.ts";
import {
  discoverContent,
  extractHeadings,
  slugify,
} from "../src/core/content.ts";
import { buildContentGraph } from "../src/core/graph.ts";
import { buildManifest } from "../src/core/manifest.ts";
import { scanProject } from "../src/core/project-graph.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema, pageMetaSchema } from "../src/core/schema.ts";
import type { PageRecord, ProjectContext } from "../src/core/types.ts";
import { buildRobots } from "../src/deploy/robots.ts";
import { buildRssFeeds, renderRssFeed } from "../src/deploy/rss.ts";
import { buildSitemap } from "../src/deploy/sitemap.ts";
import { generateApiDocs, parseOpenApi } from "../src/openapi/import.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";
import { buildStructuredData } from "../src/seo/jsonld.ts";
import { buildThemeCss } from "../src/theme/palette.ts";

const makePage = (
  over: Pick<PageRecord, "id" | "route" | "title"> & Partial<PageRecord>
): PageRecord => ({
  contentType: "doc",
  format: "mdx",
  groups: [],
  headings: [],
  links: [],
  meta: pageMetaSchema.parse({}),
  segments: [],
  sourcePath: `/abs/${over.id}`,
  ...over,
});

const withLlmsTxt = (project: BlumeProject): BlumeProject => ({
  ...project,
  config: {
    ...project.config,
    ai: {
      ...project.config.ai,
      llmsTxt: true,
    },
  },
});

const createMintlifyFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-mintlify-"));
  await mkdir(join(root, "drafts"));
  await mkdir(join(root, "snippets"));
  await writeFile(
    join(root, "docs.json"),
    JSON.stringify({
      $schema: "https://mintlify.com/docs.json",
      api: {
        examples: {
          defaults: "required",
          languages: ["curl", "javascript"],
          prefill: true,
        },
        playground: {
          credentials: true,
          display: "interactive",
          proxy: false,
        },
      },
      appearance: {
        default: "light",
        strict: true,
      },
      background: {
        color: {
          dark: "#06110B",
          light: "#F8FAFC",
        },
        decoration: "grid",
        image: {
          dark: "/images/background-dark.svg",
          light: "/images/background-light.svg",
        },
      },
      banner: {
        content: "Version **2.0** is live. Read the [quickstart](/quickstart).",
        dismissible: true,
        type: "warning",
      },
      colors: { dark: "#15803D", light: "#07C983", primary: "#16A34A" },
      contextual: {
        options: ["copy", "view", "chatgpt"],
      },
      favicon: "/favicon.svg",
      fonts: {
        body: { family: "Inter", weight: 400 },
        family: "Inter",
        heading: { family: "Inter", weight: 650 },
      },
      footer: {
        links: [
          {
            header: "Resources",
            items: [
              { href: "/quickstart", label: "Quickstart" },
              { href: "https://github.com", label: "GitHub" },
            ],
          },
        ],
        socials: {
          github: "https://github.com",
          linkedin: "https://linkedin.com/company/blume",
          x: "https://x.com/blume",
        },
      },
      icons: { library: "fontawesome" },
      logo: { dark: "/logo/dark.svg", light: "/logo/light.svg" },
      name: "Mintlify-shaped docs",
      navbar: {
        links: [{ href: "mailto:hi@blume.dev", label: "Support" }],
        primary: {
          href: "https://github.com",
          label: "GitHub",
          type: "button",
        },
      },
      navigation: {
        global: {
          anchors: [{ anchor: "GitHub", href: "https://github.com" }],
        },
        pages: [
          {
            group: "Getting Started",
            pages: ["index", "quickstart"],
          },
          {
            group: "API Reference",
            openapi: "/openapi.json",
          },
        ],
      },
      search: {
        prompt: "Search the garden...",
      },
      seo: {
        metatags: {
          "og:site_name": "Blume Starter Kit",
          "theme-color": "#16A34A",
          "twitter:site": "@blume",
        },
      },
      styling: {
        codeblocks: "dark",
        eyebrows: "breadcrumbs",
        latex: true,
      },
      theme: "mint",
      variables: {
        "product-name": "Blume Garden",
      },
    })
  );
  await writeFile(join(root, ".mintignore"), "drafts/\n");
  await writeFile(
    join(root, "custom.css"),
    ".mintlify-custom-proof { color: rgb(22 163 74); }\n"
  );
  await writeFile(
    join(root, "index.mdx"),
    [
      "---",
      'title: "{{product-name}} Intro"',
      "sidebarTitle: Start",
      "icon: rocket",
      "tag: NEW",
      "---",
      "",
      "Welcome to {{product-name}}.",
      "",
    ].join("\n")
  );
  await writeFile(
    join(root, "quickstart.mdx"),
    [
      "---",
      "title: Quickstart",
      "description: Start quickly.",
      "canonical: https://docs.example.com/quickstart",
      'keywords: ["setup", "flowers"]',
      "noindex: true",
      '"og:image": "https://docs.example.com/images/quickstart-card.png"',
      '"og:locale": "en_US"',
      '"twitter:card": "summary"',
      "---",
      "",
      '<Visibility for="web">',
      "Click the **Get started** button.",
      "</Visibility>",
      "",
      '<Visibility for="agents">',
      "Call `POST /v1/accounts` with a valid email.",
      "</Visibility>",
      "",
    ].join("\n")
  );
  await writeFile(
    join(root, "openapi.json"),
    JSON.stringify({
      info: {
        description: "A fixture API.",
        title: "Fixture API",
        version: "1.0.0",
      },
      openapi: "3.0.0",
      paths: {
        "/hidden-pets": {
          get: {
            operationId: "hiddenPets",
            responses: { "200": { description: "Hidden pets." } },
            summary: "Hidden pets",
            "x-hidden": true,
          },
        },
        "/internal-pets": {
          get: {
            operationId: "internalPets",
            responses: { "200": { description: "Internal pets." } },
            summary: "Internal pets",
            "x-excluded": true,
          },
        },
        "/legacy-pets": {
          get: {
            deprecated: true,
            operationId: "legacyPets",
            responses: { "200": { description: "Legacy pets." } },
            summary: "Legacy pets",
          },
        },
        "/pets": {
          get: {
            operationId: "listPets",
            responses: { "200": { description: "Pets." } },
            summary: "List pets",
          },
          post: {
            operationId: "createPet",
            responses: { "201": { description: "Created." } },
            summary: "Create a pet",
          },
        },
      },
      servers: [{ url: "https://api.example.com" }],
    })
  );
  await writeFile(join(root, "README.md"), "---\ntitle: Ignored\n---\n");
  await writeFile(
    join(root, "drafts", "secret.mdx"),
    "---\ntitle: Secret\n---\n"
  );
  await writeFile(
    join(root, "snippets", "reusable.mdx"),
    "---\ntitle: Hidden snippet\n---\nSnippet-only content.\n"
  );
  return root;
};

const createMintlifyNavigationFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-mintlify-nav-"));
  await Promise.all(
    ["en", "guides", "product-a", "resources", "sdk", "v2"].map((dir) =>
      mkdir(join(root, dir), { recursive: true })
    )
  );
  await writeFile(
    join(root, "docs.json"),
    JSON.stringify({
      $schema: "https://mintlify.com/docs.json",
      name: "Mintlify navigation modes",
      navigation: {
        dropdowns: [{ dropdown: "Resources", pages: ["resources/reference"] }],
        global: {
          anchors: [{ anchor: "Support", href: "https://example.com/support" }],
        },
        languages: [
          {
            banner: {
              content: "English docs",
              type: "info",
            },
            footer: {
              links: [
                {
                  header: "English resources",
                  items: [{ href: "/en/intro", label: "English intro" }],
                },
              ],
            },
            language: "en",
            navbar: {
              links: [{ href: "/en/intro", label: "English docs" }],
              primary: {
                href: "/en/intro",
                label: "Start in English",
                type: "button",
              },
            },
            pages: ["en/intro"],
          },
        ],
        products: [
          {
            groups: [{ group: "Guides", pages: ["product-a/overview"] }],
            product: "Product A",
            root: "product-a/overview",
          },
        ],
        tabs: [
          { icon: "book-open", pages: ["guides/intro"], tab: "Guides" },
          {
            menu: [
              {
                description: "Client libraries.",
                icon: "code",
                item: "SDKs",
                pages: ["sdk/js"],
              },
            ],
            tab: "Developers",
          },
          { openapi: "/openapi.json", tab: "API" },
        ],
        versions: [{ pages: ["v2/intro"], tag: "Latest", version: "v2" }],
      },
    })
  );
  await writeFile(
    join(root, "openapi.json"),
    JSON.stringify({
      info: { title: "Fixture API", version: "1.0.0" },
      openapi: "3.0.0",
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            responses: { "200": { description: "OK." } },
            summary: "List things",
          },
        },
      },
    })
  );
  await Promise.all(
    [
      "en/intro",
      "guides/intro",
      "product-a/overview",
      "resources/reference",
      "sdk/js",
      "v2/intro",
    ].map((page) =>
      writeFile(join(root, `${page}.mdx`), "---\ntitle: Test\n---\n")
    )
  );
  return root;
};

const createMintlifyNestedNavigationFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "blume-mintlify-nested-nav-"));
  await Promise.all(
    ["guides"].map((dir) => mkdir(join(root, dir), { recursive: true }))
  );
  await writeFile(
    join(root, "docs.json"),
    JSON.stringify({
      $schema: "https://mintlify.com/docs.json",
      name: "Nested Mintlify navigation",
      navigation: {
        tabs: [
          {
            anchors: [
              {
                anchor: "Guides",
                icon: "book-open",
                pages: ["guides/quickstart", "guides/tutorial"],
              },
              {
                anchor: "API Reference",
                icon: "code",
                openapi: "/openapi.json",
              },
            ],
            tab: "Documentation",
          },
          {
            groups: [{ group: "Help", pages: ["support", "faq"] }],
            tab: "Resources",
          },
        ],
      },
    })
  );
  await writeFile(
    join(root, "openapi.json"),
    JSON.stringify({
      info: { title: "Nested API", version: "1.0.0" },
      openapi: "3.0.0",
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            responses: { "200": { description: "OK." } },
            summary: "List things",
          },
        },
      },
    })
  );
  await Promise.all(
    ["guides/quickstart", "guides/tutorial", "support", "faq"].map((page) =>
      writeFile(join(root, `${page}.mdx`), "---\ntitle: Test\n---\n")
    )
  );
  return root;
};

const writeAsyncApiFixture = async (root: string): Promise<void> => {
  await writeFile(
    join(root, "asyncapi.json"),
    JSON.stringify({
      asyncapi: "3.0.0",
      channels: {
        userUpdates: {
          address: "users/{userId}/updates",
          description: "Real-time user lifecycle updates.",
          messages: {
            UserUpdated: { $ref: "#/components/messages/UserUpdated" },
          },
          title: "User updates",
        },
      },
      components: {
        messages: {
          UserUpdated: {
            payload: { $ref: "#/components/schemas/UserUpdatedPayload" },
            summary: "A user profile changed.",
            title: "User updated",
          },
        },
        schemas: {
          UserUpdatedPayload: {
            properties: {
              email: {
                description: "The user's new email address.",
                format: "email",
                type: "string",
              },
              profile: {
                description: "Updated profile details.",
                properties: {
                  displayName: {
                    description: "Public display name.",
                    type: "string",
                  },
                  roles: {
                    description: "Assigned user roles.",
                    items: { type: "string" },
                    type: "array",
                  },
                },
                required: ["displayName"],
                type: "object",
              },
              revisions: {
                description: "Changed fields in this update.",
                items: {
                  properties: {
                    field: {
                      description: "Changed field name.",
                      type: "string",
                    },
                    value: {
                      description: "Changed field value.",
                      oneOf: [
                        {
                          properties: {
                            text: {
                              description: "String value.",
                              type: "string",
                            },
                          },
                          title: "StringValue",
                          type: "object",
                        },
                        {
                          properties: {
                            amount: {
                              description: "Numeric value.",
                              type: "number",
                            },
                          },
                          title: "NumberValue",
                          type: "object",
                        },
                      ],
                    },
                  },
                  required: ["field"],
                  type: "object",
                },
                type: "array",
              },
              userId: {
                description: "The stable user identifier.",
                type: "string",
              },
            },
            required: ["userId"],
            type: "object",
          },
        },
      },
      info: {
        description: "A fixture event stream.",
        title: "Fixture Events",
        version: "1.0.0",
      },
      operations: {
        receiveUserUpdates: {
          action: "receive",
          channel: { $ref: "#/channels/userUpdates" },
          messages: [{ $ref: "#/components/messages/UserUpdated" }],
          summary: "Receive user updates",
        },
      },
    })
  );
};

const createMintlifyAsyncApiFixture = async (): Promise<string> => {
  const root = await createMintlifyFixture();
  await writeAsyncApiFixture(root);
  const raw = await readFile(join(root, "docs.json"), "utf-8");
  const spec = JSON.parse(raw);
  spec.navigation.pages.push({
    asyncapi: {
      directory: "events",
      source: "/asyncapi.json",
    },
    group: "Event Reference",
  });
  await writeFile(join(root, "docs.json"), JSON.stringify(spec));
  return root;
};

const renderContentConfig = (): string => {
  const config = blumeConfigSchema.parse({
    content: {
      exclude: ["**/.*", ".blume/**", "drafts/**"],
      include: ["**/*.{md,mdx}"],
      root: ".",
    },
  });
  const context = {
    contentRoot: "/r",
  } as ProjectContext;

  return contentConfigTemplate({ config, context });
};
const postPage = (
  id: string,
  route: string,
  type: string,
  meta: Record<string, unknown>
): PageRecord =>
  makePage({
    contentType: type,
    description: `About ${id}`,
    id,
    meta: pageMetaSchema.parse({ type, ...meta }),
    route,
    title: id,
  });

const makeProject = (
  pages: PageRecord[],
  config: Record<string, unknown> = {}
): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({
      deployment: { site: "https://example.com" },
      title: "Docs",
      ...config,
    }),
    graph: { pages },
  }) as unknown as BlumeProject;

const graphOf = (
  data: Record<string, unknown> | null
): Record<string, unknown>[] =>
  (data?.["@graph"] ?? []) as Record<string, unknown>[];

describe("config schema", () => {
  it("applies defaults for an empty config", () => {
    const config = blumeConfigSchema.parse({});
    expect(config).toMatchObject({
      api: { asyncapi: [], openapi: [] },
      content: { root: "docs" },
      deployment: { output: "static" },
      markdown: { schema: true },
      navigation: { chromeVariants: [], selectors: [], sidebarVariants: [] },
      search: { provider: "orama" },
      seo: { metatags: {} },
      styling: { eyebrows: "section" },
      theme: { strict: false },
      title: "Documentation",
      variables: {},
    });
  });

  it("applies defaults for optional Mintlify-compatible chrome", () => {
    const config = blumeConfigSchema.parse({});
    expect(config.banner).toBeUndefined();
    expect(config.contextual).toStrictEqual({
      display: "header",
      options: [],
    });
    expect(config.footer.links).toStrictEqual([]);
    expect(config.footer.socials).toStrictEqual({});
    expect(config.navbar.links).toStrictEqual([]);
  });

  it("rejects unknown top-level keys", () => {
    expect(blumeConfigSchema.safeParse({ nope: true }).success).toBeFalsy();
  });

  it("nests og, rss, and structured data under seo", () => {
    const { seo } = blumeConfigSchema.parse({});
    expect(seo.og.enabled).toBeFalsy();
    expect(seo.rss.enabled).toBeTruthy();
    expect(seo.rss.types).toStrictEqual(["blog", "changelog"]);
    expect(seo.structuredData).toBeTruthy();
    expect(
      blumeConfigSchema.safeParse({ og: { enabled: true } }).success
    ).toBeFalsy();
  });

  it("accepts a banner string or object, defaulting dismissible to false", () => {
    expect(blumeConfigSchema.parse({ banner: "Beta" }).banner).toBe("Beta");
    expect(
      blumeConfigSchema.parse({ banner: { content: "Hi" } }).banner
    ).toStrictEqual({ content: "Hi", dismissible: false });
    expect(
      blumeConfigSchema.safeParse({ banner: { dismissible: true } }).success
    ).toBeFalsy();
  });
});

describe("theme palette", () => {
  it("emits a dark accent override when configured", () => {
    const config = blumeConfigSchema.parse({
      theme: {
        accent: "#16A34A",
        accentDark: "#07C983",
        action: "#15803D",
        background: "#F8FAFC",
        backgroundDark: "#06110B",
        backgroundDecoration: "grid",
        backgroundImage: "/images/background-light.svg",
        backgroundImageDark: "/images/background-dark.svg",
      },
    });
    const output = buildThemeCss(config.theme);

    expect({
      accent: output.includes("--blume-accent: #16A34A"),
      action: output.includes("--blume-action: #15803D"),
      actionForeground: output.includes(
        "--blume-action-foreground: oklch(1 0 0)"
      ),
      background: output.includes("--blume-background: #F8FAFC"),
      backgroundDecoration: output.includes(
        "--blume-background-decoration: linear-gradient"
      ),
      backgroundImage: output.includes(
        '--blume-background-image: url("/images/background-light.svg")'
      ),
      darkAccent: output.includes("--blume-accent: #07C983"),
      darkBackground: output.includes("--blume-background: #06110B"),
      darkBackgroundImage: output.includes(
        '--blume-background-image: url("/images/background-dark.svg")'
      ),
      darkRoot: output.includes(':root[data-theme="dark"]'),
    }).toStrictEqual({
      accent: true,
      action: true,
      actionForeground: true,
      background: true,
      backgroundDecoration: true,
      backgroundImage: true,
      darkAccent: true,
      darkBackground: true,
      darkBackgroundImage: true,
      darkRoot: true,
    });
  });

  it("emits configured body and heading font tokens", () => {
    const config = blumeConfigSchema.parse({
      theme: {
        fonts: {
          body: { family: "Inter", weight: 400 },
          family: "Inter",
          heading: {
            family: "Fraunces",
            format: "woff2",
            source: "/fonts/fraunces.woff2",
            weight: 650,
          },
        },
      },
    });
    const output = buildThemeCss(config.theme);

    expect({
      bodyFamily: output.includes('--blume-font-body: "Inter"'),
      bodyWeight: output.includes("--blume-font-body-weight: 400"),
      fontFaceFamily: output.includes('font-family: "Fraunces"'),
      fontFaceSource: output.includes(
        'src: url("/fonts/fraunces.woff2") format("woff2")'
      ),
      headingFamily: output.includes('--blume-font-heading: "Fraunces"'),
      headingWeight: output.includes("--blume-font-heading-weight: 650"),
    }).toStrictEqual({
      bodyFamily: true,
      bodyWeight: true,
      fontFaceFamily: true,
      fontFaceSource: true,
      headingFamily: true,
      headingWeight: true,
    });
  });
});

describe("astro config template", () => {
  it("emits dual light and dark Shiki themes", () => {
    const config = blumeConfigSchema.parse({});
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      publicRoot: "/r/public",
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      config,
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      markdownDataPath: "/r/.blume/src/generated/markdown.json",
      needsReact: false,
      pages: [],
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).toContain(
      'themes: {"dark":"github-dark","light":"github-light"}'
    );
    expect(output).toContain("defaultColor: false");
  });

  it("emits configured Shiki themes", () => {
    const config = blumeConfigSchema.parse({
      markdown: {
        codeBlocks: {
          theme: {
            dark: "custom-dark",
            light: "custom-light",
          },
        },
      },
    });
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      publicRoot: "/r/public",
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      config,
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      markdownDataPath: "/r/.blume/src/generated/markdown.json",
      needsReact: false,
      pages: [],
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).toContain(
      'themes: {"dark":"custom-dark","light":"custom-light"}'
    );
  });

  it("resolves Mintlify absolute snippet imports from the project root", () => {
    const config = blumeConfigSchema.parse({
      variables: { "product-name": "Blume Garden" },
    });
    const context = {
      configFile: "/r/docs.json",
      outDir: "/r/.blume",
      pagesRoot: null,
      publicRoot: "/r/.blume/public",
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      config,
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      markdownDataPath: "/r/.blume/src/generated/markdown.json",
      needsReact: true,
      pages: [],
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(
      [
        'name: "blume-mintlify-mdx-snippets"',
        'import { existsSync } from "node:fs";',
        "rewriteMintlifyGlobalVariables",
        "rewriteMintlifyAsyncApiPage",
        "rewriteMintlifyManualApiPage",
        "rewriteMintlifyMarkdownSnippets",
        "rewriteMintlifyOpenApiSchemaPage",
        "rewriteMintlifyUserVariable",
        '"product-name":"Blume Garden"',
        'const projectRoot = "/r";',
        "return candidate;",
      ].filter((needle) => !output.includes(needle))
    ).toStrictEqual([]);
  });

  it("emits dev Markdown Accept-header middleware when llms exports are enabled", () => {
    const config = blumeConfigSchema.parse({ ai: { llmsTxt: true } });
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      publicRoot: "/r/public",
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      config,
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      markdownDataPath: "/r/.blume/src/generated/markdown.json",
      needsReact: false,
      pages: [],
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).toContain('name: "blume-markdown-accept"');
    expect(output).toContain(
      'await readFile("/r/.blume/src/generated/markdown.json", "utf-8")'
    );
    expect(output).toContain("request.headers.accept");
    expect(output).toContain("text/markdown;charset=utf-8");
  });

  it("allows KaTeX package assets in dev when math rendering is enabled", () => {
    const config = blumeConfigSchema.parse({ markdown: { math: true } });
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      publicRoot: "/r/public",
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      config,
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      markdownDataPath: "/r/.blume/src/generated/markdown.json",
      needsReact: false,
      pages: [],
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).toContain('import { createRequire } from "node:module";');
    expect(output).toContain('import { dirname } from "node:path";');
    expect(output).toContain("const require = createRequire(import.meta.url);");
    expect(output).toContain(
      'allow: ["/r", dirname(require.resolve("katex/package.json"))]'
    );
  });

  it("does not emit API playground proxy middleware", () => {
    const config = blumeConfigSchema.parse({});
    const context = {
      outDir: "/r/.blume",
      pagesRoot: null,
      publicRoot: "/r/public",
      root: "/r",
    } as ProjectContext;

    const output = astroConfigTemplate({
      config,
      context,
      dataPath: "/r/.blume/src/generated/data.json",
      markdownDataPath: "/r/.blume/src/generated/markdown.json",
      needsReact: false,
      pages: [],
      themePath: "/r/.blume/src/generated/app.css",
    });

    expect(output).not.toContain("blume-api-playground-proxy");
    expect(output).not.toContain("/api/blume/proxy");
  });
});

describe("Mintlify OpenAPI pages", () => {
  it("renders manual api frontmatter pages as static endpoint docs", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-manual-api-page-"));
    try {
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          api: {
            mdx: {
              auth: { method: "key", name: "x-api-key" },
              server: "https://api.example.com",
            },
            playground: {
              credentials: true,
              display: "interactive",
              proxy: false,
            },
          },
          name: "Manual API docs",
          navigation: {
            pages: ["create-user"],
          },
        })
      );
      await writeFile(
        join(root, "create-user.mdx"),
        [
          "---",
          "title: Create user",
          'api: "POST /v1/users/{userId}"',
          "deprecated: true",
          "---",
          "",
          "Create a user manually.",
          "",
          '<ParamField path="userId" type="string" required>',
          "  User identifier.",
          "</ParamField>",
          "",
          '<ParamField query="notify" type="boolean" default={true}>',
          "  Notify the user.",
          "</ParamField>",
          "",
          '<ParamField body="email" type="string" required placeholder="alex@example.com">',
          "  User email.",
          "</ParamField>",
          "",
          '<ResponseField name="id" type="string" required>',
          "  Created user identifier.",
          "</ResponseField>",
          "",
        ].join("\n")
      );

      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.id === "create-user.mdx"
      );
      if (!page) {
        throw new Error("Manual API page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);

      expect({
        apiLayout: page.contentType,
        endpoint: markdown.includes(
          '<Endpoint method="POST" path={"/v1/users/{userId}"} deprecated={true} server={"https://api.example.com"} tryIt={false} />'
        ),
        noPlayground: !markdown.includes("<ApiPlayground"),
        preservesFields:
          markdown.includes('<ParamField path="userId"') &&
          markdown.includes('<ParamField query="notify"') &&
          markdown.includes('<ParamField body="email"') &&
          markdown.includes('<ResponseField name="id"'),
      }).toStrictEqual({
        apiLayout: "api",
        endpoint: true,
        noPlayground: true,
        preservesFields: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders openapi frontmatter endpoint docs after custom content", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-endpoint-page-"));
    try {
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          name: "Endpoint docs",
          navigation: {
            pages: ["endpoint"],
          },
        })
      );
      await writeFile(
        join(root, "openapi.json"),
        JSON.stringify({
          info: { title: "Pets API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/pets/{petId}": {
              get: {
                callbacks: {
                  petUpdated: {
                    "{$request.body#/callbackUrl}": {
                      post: {
                        requestBody: {
                          content: {
                            "application/json": {
                              schema: {
                                properties: {
                                  status: {
                                    description: "Updated pet status.",
                                    type: "string",
                                  },
                                },
                                type: "object",
                              },
                            },
                          },
                        },
                        responses: {
                          "200": {
                            description: "Callback received.",
                          },
                        },
                      },
                    },
                  },
                },
                description: "Returns a pet.",
                operationId: "getPet",
                parameters: [
                  {
                    description: "Pet identifier.",
                    in: "path",
                    name: "petId",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        schema: {
                          properties: {
                            id: {
                              description: "Stable pet identifier.",
                              type: "string",
                            },
                          },
                          required: ["id"],
                          type: "object",
                        },
                      },
                    },
                    description: "Pet response.",
                  },
                },
                summary: "Get pet",
              },
            },
          },
          servers: [{ url: "https://api.example.com" }],
        })
      );
      await writeFile(
        join(root, "endpoint.mdx"),
        [
          "---",
          "title: Pet details",
          'openapi: "openapi.json GET /pets/{petId}/"',
          "---",
          "",
          "Custom overview.",
          "",
        ].join("\n")
      );

      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.id === "endpoint.mdx"
      );
      if (!page) {
        throw new Error("Endpoint page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);

      expect({
        apiLayout: page.contentType,
        callback:
          markdown.includes("## Callbacks") &&
          markdown.includes("#### petUpdated") &&
          markdown.includes('path={"{$request.body#/callbackUrl}"}'),
        customBeforeEndpoint:
          markdown.indexOf("Custom overview.") < markdown.indexOf("<Endpoint"),
        endpoint: markdown.includes(
          '<Endpoint method="GET" path={"/pets/{petId}"} server={"https://api.example.com"} requestExampleId="blume-request-example" />'
        ),
        pathParameter: markdown.includes('"name":"petId"'),
        responseField: markdown.includes('"name":"id"'),
      }).toStrictEqual({
        apiLayout: "api",
        callback: true,
        customBeforeEndpoint: true,
        endpoint: true,
        pathParameter: true,
        responseField: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders webhook openapi frontmatter pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-webhook-page-"));
    try {
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          name: "Webhook docs",
          navigation: {
            pages: ["webhook"],
          },
        })
      );
      await writeFile(
        join(root, "openapi.json"),
        JSON.stringify({
          info: { title: "Webhook API", version: "1.0.0" },
          openapi: "3.1.0",
          paths: {},
          webhooks: {
            orderUpdated: {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        properties: {
                          orderId: {
                            description: "Order identifier.",
                            type: "string",
                          },
                        },
                        required: ["orderId"],
                        type: "object",
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "Webhook received.",
                  },
                },
                summary: "Order updated webhook",
              },
            },
          },
        })
      );
      await writeFile(
        join(root, "webhook.mdx"),
        [
          "---",
          "title: Order updated webhook",
          'openapi: "openapi.json webhook orderUpdated"',
          "---",
          "",
          "Custom webhook notes.",
          "",
        ].join("\n")
      );

      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.id === "webhook.mdx"
      );
      if (!page) {
        throw new Error("Webhook page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);

      expect({
        apiLayout: page.contentType,
        bodyField: markdown.includes('"name":"orderId"'),
        customBeforeEndpoint:
          markdown.indexOf("Custom webhook notes.") <
          markdown.indexOf("<Endpoint"),
        endpoint: markdown.includes(
          '<Endpoint method="POST" path={"orderUpdated"} tryIt={false} />'
        ),
      }).toStrictEqual({
        apiLayout: "api",
        bodyField: true,
        customBeforeEndpoint: true,
        endpoint: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders openapi-schema frontmatter from components.schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-schema-page-"));
    try {
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          name: "Schema docs",
          navigation: {
            pages: ["model"],
          },
          openapi: "/openapi.json",
        })
      );
      await writeFile(
        join(root, "openapi.json"),
        JSON.stringify({
          components: {
            schemas: {
              Pet: {
                description: "Pet object.",
                properties: {
                  id: {
                    description: "Stable pet identifier.",
                    type: "string",
                  },
                  profile: {
                    properties: {
                      age: {
                        description: "Pet age.",
                        type: "integer",
                      },
                    },
                    type: "object",
                  },
                },
                required: ["id"],
                title: "Pet",
                type: "object",
              },
            },
          },
          info: { title: "Pets API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {},
        })
      );
      await writeFile(
        join(root, "model.mdx"),
        '---\nopenapi-schema: "openapi.json Pet"\n---\n'
      );

      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.id === "model.mdx"
      );
      if (!page) {
        throw new Error("Schema page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);

      expect({
        graphHeading: page.headings.some((heading) => heading.text === "Pet"),
        graphTitle: page.title,
        markdownDescription: markdown.includes("Pet object."),
        nestedProperty: markdown.includes('"name":"profile.age"'),
        requiredProperty:
          markdown.includes('"name":"id"') &&
          markdown.includes('"required":true'),
      }).toStrictEqual({
        graphHeading: true,
        graphTitle: "Pet",
        markdownDescription: true,
        nestedProperty: true,
        requiredProperty: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("content config template", () => {
  it("passes include and exclude patterns separately to the Blume loader", () => {
    const output = renderContentConfig();

    expect(output).toContain(
      'import { blumeContentLoader } from "blume/astro"'
    );
    expect(output).toContain("additionalBases: []");
    expect(output).toContain('ignore: ["**/.*",".blume/**","drafts/**"]');
    expect(output).toContain('pattern: ["**/*.{md,mdx}"]');
  });

  it("does not emit negated ignore patterns for the Blume loader", () => {
    const output = renderContentConfig();

    expect(output).not.toContain('"!**/.*"');
    expect(output).not.toContain('"!.blume/**"');
  });
});

describe("MDX component template", () => {
  it("registers Mintlify component aliases and namespaces", () => {
    const output = catchAllPageTemplate({
      askEnabled: false,
      mathEnabled: false,
    });

    expect(output).toContain(
      "const Color = Object.assign(ColorRoot, { Item: ColorItem, Row: ColorRow });"
    );
    expect(output).toContain(
      "const Tree = Object.assign(TreeRoot, { File: TreeFile, Folder: TreeFolder });"
    );
    for (const name of [
      "AccordionItem",
      "CodeGroup",
      "Panel",
      "ParamField",
      "Prompt",
      "ResponseField",
      "Tile",
      "Visibility",
    ]) {
      expect(output).toContain(`  ${name},`);
    }
  });

  it("keeps the docs catch-all prerendered", () => {
    const output = catchAllPageTemplate({
      askEnabled: false,
      mathEnabled: false,
    });

    expect(output).toContain("export const prerender = true");
    expect(output).not.toContain("Astro.request.headers");
  });

  it("passes global banner config to the root layout", () => {
    const output = catchAllPageTemplate({
      askEnabled: false,
      mathEnabled: false,
    });

    expect(output).toContain("banner={data.config.banner}");
  });
});

describe("Mintlify CLI compatibility", () => {
  it("fails unsupported Mintlify commands with local compatibility messaging", () => {
    const mintBinary = fileURLToPath(
      new URL("../bin/mint.mjs", import.meta.url)
    );
    const result = spawnSync(process.execPath, [mintBinary, "broken-links"], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain(
      "`mint broken-links` is not supported by Blume's local Mintlify compatibility."
    );
    expect(output).toContain(
      "Blume supports `mint dev`, `mint build`, and `mint preview`"
    );
  });
});

describe("Mintlify compatibility config", () => {
  it("loads docs.json as Blume config", async () => {
    const root = await createMintlifyFixture();
    try {
      const { config, configFile } = await loadConfig(root);
      expect(configFile).toBe(join(root, "docs.json"));
      expect(config).toMatchObject({
        api: {
          examples: {
            defaults: "required",
            languages: ["curl", "javascript"],
            prefill: true,
          },
          playground: {
            credentials: true,
            display: "interactive",
            proxy: false,
          },
        },
        banner: {
          content:
            "Version **2.0** is live. Read the [quickstart](/quickstart).",
          dismissible: true,
          type: "warning",
        },
        content: { root: "." },
        contextual: {
          display: "header",
          options: ["copy", "view", "chatgpt"],
        },
        favicon: "/favicon.svg",
        footer: {
          links: [
            {
              header: "Resources",
              items: [
                { href: "/quickstart", label: "Quickstart" },
                { href: "https://github.com", label: "GitHub" },
              ],
            },
          ],
          socials: {
            github: "https://github.com",
            linkedin: "https://linkedin.com/company/blume",
            x: "https://x.com/blume",
          },
        },
        icons: { library: "fontawesome" },
        logo: {
          dark: "/logo/dark.svg",
          light: "/logo/light.svg",
        },
        markdown: {
          codeBlocks: {
            theme: {
              dark: "github-dark",
              light: "github-dark",
            },
          },
          math: true,
          schema: true,
        },
        navbar: {
          links: [{ href: "mailto:hi@blume.dev", label: "Support" }],
          primary: {
            href: "https://github.com",
            label: "GitHub",
            type: "button",
          },
        },
        search: {
          prompt: "Search the garden...",
        },
        styling: {
          eyebrows: "breadcrumbs",
        },
        theme: {
          accent: "#16A34A",
          accentDark: "#07C983",
          action: "#15803D",
          background: "#F8FAFC",
          backgroundDark: "#06110B",
          backgroundDecoration: "grid",
          backgroundImage: "/images/background-light.svg",
          backgroundImageDark: "/images/background-dark.svg",
          fonts: {
            body: { family: "Inter", weight: 400 },
            family: "Inter",
            heading: { family: "Inter", weight: 650 },
          },
          mode: "light",
          strict: true,
        },
        title: "Mintlify-shaped docs",
        variables: {
          "product-name": "Blume Garden",
        },
      });
      expect(config.api.openapi).toStrictEqual([
        { directory: "api-reference", source: "/openapi.json" },
      ]);
      expect(config.navigation.tabs?.[0]).toStrictEqual({
        label: "GitHub",
        path: "https://github.com",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify background string images", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-mintlify-bg-"));
    try {
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          background: {
            decoration: "gradient",
            image: "/background.png",
          },
          colors: { primary: "#16A34A" },
          name: "Background docs",
          navigation: { pages: ["index"] },
          theme: "mint",
        })
      );
      await writeFile(join(root, "index.mdx"), "---\ntitle: Home\n---\n");

      const { config } = await loadConfig(root);

      expect(config.theme).toMatchObject({
        backgroundDecoration: "gradient",
        backgroundImage: "/background.png",
      });
      expect(config.theme.backgroundImageDark).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify api.params post pills", async () => {
    const root = await createMintlifyFixture();
    try {
      const raw = await readFile(join(root, "docs.json"), "utf-8");
      const spec = JSON.parse(raw);
      spec.api.params = { post: ["nullable", "x-internal"] };
      await writeFile(join(root, "docs.json"), JSON.stringify(spec));

      const { config } = await loadConfig(root);
      expect(config.api.params).toStrictEqual({
        post: ["nullable", "x-internal"],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("scans root MDX pages, navigation, and .mintignore", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      expect(project.graph.pages.map((page) => page.route)).toStrictEqual([
        "/",
        "/quickstart",
        "/api-reference/create-pet",
        "/api-reference/hidden-pets",
        "/api-reference",
        "/api-reference/legacy-pets",
        "/api-reference/list-pets",
      ]);
      expect(
        project.graph.pages.find((page) => page.route === "/")?.title
      ).toBe("Blume Garden Intro");
      expect(project.graph.navigation.sidebar).toMatchObject([
        {
          children: [
            {
              badge: "NEW",
              icon: "rocket",
              label: "Start",
              route: "/",
            },
            { label: "Quickstart", route: "/quickstart" },
          ],
          label: "Getting Started",
        },
        {
          children: [
            { label: "Fixture API", route: "/api-reference" },
            {
              apiMethod: "GET",
              deprecated: true,
              label: "Legacy pets",
              route: "/api-reference/legacy-pets",
            },
            {
              apiMethod: "GET",
              label: "List pets",
              route: "/api-reference/list-pets",
            },
            {
              apiMethod: "POST",
              label: "Create a pet",
              route: "/api-reference/create-pet",
            },
          ],
          label: "API Reference",
        },
      ]);
      const search = await buildSearchDocuments(project);
      expect(search.find((document) => document.route === "/")).toMatchObject({
        content: "Welcome to Blume Garden.",
        title: "Blume Garden Intro",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates Mintlify-style Markdown exports for agents", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.route === "/quickstart"
      );
      if (!page) {
        throw new Error("Quickstart page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);
      expect(markdown).toContain("Call `POST /v1/accounts`");
      expect(markdown).not.toContain("Get started");
      expect(markdown).not.toContain("<Visibility");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("includes OpenAPI schemas in Mintlify Markdown exports by default", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.route === "/api-reference/list-pets"
      );
      if (!page) {
        throw new Error("OpenAPI page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);
      expect(markdown).toContain("## OpenAPI schema");
      expect(markdown).toContain("Source: /openapi.json");
      expect(markdown).toContain('"openapi":"3.0.0"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fetches remote OpenAPI schemas for Mintlify Markdown exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-remote-schema-"));
    const sourcePath = join(root, "remote.mdx");
    const config = blumeConfigSchema.parse({
      api: {
        openapi: [
          {
            directory: "api-reference",
            source: "https://example.test/openapi.json?version=1",
          },
        ],
      },
    });
    const page = makePage({
      id: "remote.mdx",
      route: "/api-reference/list-pets",
      sourcePath,
      title: "Remote API",
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('{"openapi":"3.1.0"}'))
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await writeFile(sourcePath, "---\ntitle: Remote API\n---\n\nBody.\n");
      const project: BlumeProject = {
        config,
        context: {
          componentsFile: null,
          configFile: join(root, "docs.json"),
          contentRoot: root,
          generatedContentRoot: null,
          outDir: join(root, ".blume"),
          pagesRoot: null,
          publicRoot: join(root, "public"),
          root,
          themeFile: null,
          themeFiles: [],
        },
        diagnostics: [],
        graph: {
          diagnostics: [],
          navigation: {
            chromeVariants: [],
            selectors: [],
            sidebar: [],
            sidebarVariants: [],
            tabs: [],
          },
          pages: [page],
          routes: new Map([[page.route, page.id]]),
        },
        manifest: {
          blumeVersion: "0.0.0",
          contentRoot: root,
          output: config.deployment.output,
          projectRoot: root,
          routes: [],
          version: 1,
        },
        mode: "dev",
      };

      const markdown = await buildPageMarkdown(project, page);
      expect(markdown).toContain("## OpenAPI schema");
      expect(markdown).toContain(
        "Source: https://example.test/openapi.json?version=1"
      );
      expect(markdown).toContain('```json\n{"openapi":"3.1.0"}\n```');
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.test/openapi.json?version=1"
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("respects Mintlify markdown.schema false", async () => {
    const root = await createMintlifyFixture();
    try {
      const raw = await readFile(join(root, "docs.json"), "utf-8");
      const spec = JSON.parse(raw);
      spec.markdown = { schema: false };
      await writeFile(join(root, "docs.json"), JSON.stringify(spec));

      const project = await scanProject(root);
      expect(project.config.markdown.schema).toBeFalsy();
      const page = project.graph.pages.find(
        (candidate) => candidate.route === "/api-reference/list-pets"
      );
      if (!page) {
        throw new Error("OpenAPI page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);
      expect(markdown).not.toContain("## OpenAPI schema");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes Blume llms and Markdown artifacts", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      const { index } = await buildLlmsFiles(project);
      expect(index).toContain("- [Quickstart](/quickstart.md): Start quickly.");
      expect(index).toContain("## OpenAPI Specs");

      const outDir = join(root, "markdown-output");
      await writeLlmsArtifacts(project, outDir);
      const exported = await readFile(join(outDir, "quickstart.md"), "utf-8");
      const page = project.graph.pages.find(
        (candidate) => candidate.route === "/quickstart"
      );
      if (!page) {
        throw new Error("Quickstart page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);
      expect(exported).toBe(markdown);
      await expect(
        readFile(join(outDir, ".well-known", "llms.txt"), "utf-8")
      ).resolves.toBe(index);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes Mintlify-style changelog RSS feeds from Update components", async () => {
    const root = await createMintlifyFixture();
    try {
      const raw = await readFile(join(root, "docs.json"), "utf-8");
      const spec = JSON.parse(raw);
      spec.navigation.pages[0].pages.push("changelog");
      await writeFile(join(root, "docs.json"), JSON.stringify(spec));
      await writeFile(
        join(root, "changelog.mdx"),
        [
          "---",
          "title: Changelog",
          "description: Product updates.",
          "rss: true",
          "---",
          "",
          '<Update label="June 2026" description="v2.0.0" rss={{ title: "June release", description: "Custom RSS description." }}>',
          "  ## Ignored heading",
          "",
          "  <Frame>",
          '    <img src="/dashboard.png" alt="Dashboard" />',
          "  </Frame>",
          "</Update>",
          "",
          '<Update label="May 2026" description="v1.0.0">',
          "  ## Heading entry",
          "",
          "  Added changelog entries.",
          "</Update>",
          "",
        ].join("\n")
      );

      const project = await scanProject(root);
      const feeds = await buildChangelogRssFeeds(project);
      const content = feeds[0]?.content ?? "";
      expect({
        count: feeds.length,
        hasCustomDescription: content.includes(
          "<description><![CDATA[Custom RSS description.]]></description>"
        ),
        hasHeadingLink: content.includes("/changelog#heading-entry"),
        hasHeadingTitle: content.includes("<title><![CDATA[Heading entry]]>"),
        hasPageTitle: content.includes("<title><![CDATA[Changelog]]>"),
        hasRssTitle: content.includes("<title><![CDATA[June release]]>"),
        route: feeds[0]?.route,
      }).toStrictEqual({
        count: 1,
        hasCustomDescription: true,
        hasHeadingLink: true,
        hasHeadingTitle: true,
        hasPageTitle: true,
        hasRssTitle: true,
        route: "/changelog/rss.xml",
      });

      const outDir = join(root, "rss-output");
      await expect(writeChangelogRssFeeds(project, outDir)).resolves.toBe(1);
      await expect(
        readFile(join(outDir, "changelog", "rss.xml"), "utf-8")
      ).resolves.toBe(feeds[0]?.content);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("omits group-restricted pages from public Blume AI artifacts", async () => {
    const root = await createMintlifyFixture();
    try {
      const raw = await readFile(join(root, "docs.json"), "utf-8");
      const spec = JSON.parse(raw);
      spec.navigation.pages[0].pages.push("admin", "public-admin");
      await writeFile(join(root, "docs.json"), JSON.stringify(spec));
      await writeFile(
        join(root, "admin.mdx"),
        [
          "---",
          "title: Admin settings",
          "description: Admin-only operations.",
          'groups: ["admin"]',
          "---",
          "",
          "Private admin content.",
          "",
        ].join("\n")
      );
      await writeFile(
        join(root, "public-admin.mdx"),
        [
          "---",
          "title: Public admin playground",
          'groups: ["admin"]',
          "public: true",
          "---",
          "",
          "Public page content.",
          "",
        ].join("\n")
      );

      const project = await scanProject(root);

      const { full, index } = await buildLlmsFiles(project);
      expect({
        hasAdminRoute: project.graph.pages.some(
          (page) => page.route === "/admin"
        ),
        privateInFull: full.includes("Private admin content."),
        privateInIndex: index.includes("Admin settings"),
        publicInFull: full.includes("Public page content."),
        publicInIndex: index.includes("Public admin playground"),
      }).toStrictEqual({
        hasAdminRoute: true,
        privateInFull: false,
        privateInIndex: false,
        publicInFull: true,
        publicInIndex: true,
      });

      const outDir = join(root, "markdown-output");
      await writeLlmsArtifacts(project, outDir);
      await expect(readFile(join(outDir, "admin.md"), "utf-8")).rejects.toThrow(
        "ENOENT"
      );
      await expect(
        readFile(join(outDir, "public-admin.md"), "utf-8")
      ).resolves.toContain("Public page content.");

      const skill = await readFile(join(outDir, "skill.md"), "utf-8");
      expect({
        privateInSkill: skill.includes("Admin settings"),
        publicInSkill: skill.includes("Public admin playground"),
      }).toStrictEqual({
        privateInSkill: false,
        publicInSkill: true,
      });

      const markdownByRoute = JSON.parse(
        await buildRuntimeMarkdown(withLlmsTxt(project))
      );
      expect({
        privateRoute: markdownByRoute["/admin"],
        publicRouteHasContent:
          typeof markdownByRoute["/public-admin"] === "string" &&
          markdownByRoute["/public-admin"].includes("Public page content."),
      }).toStrictEqual({
        privateRoute: undefined,
        publicRouteHasContent: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes generated skill.md discovery artifacts", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      const outDir = join(root, "markdown-output");
      await writeLlmsArtifacts(project, outDir);
      const skill = await readFile(join(outDir, "skill.md"), "utf-8");
      const index = JSON.parse(
        await readFile(
          join(outDir, ".well-known", "agent-skills", "index.json"),
          "utf-8"
        )
      );
      const card = JSON.parse(
        await readFile(join(outDir, ".well-known", "agent-card.json"), "utf-8")
      );

      expect(skill).toContain("## Capabilities");
      expect(index.skills[0]).toMatchObject({
        name: "mintlify-shaped-docs",
        type: "skill-md",
        url: "/.well-known/agent-skills/mintlify-shaped-docs/SKILL.md",
      });
      expect(card).toMatchObject({
        capabilities: { pushNotifications: false, streaming: false },
        preferredTransport: "HTTP+JSON",
        protocolVersion: "0.3",
        provider: { organization: "Mintlify-shaped docs" },
      });
      expect(card.skills[0]).toMatchObject({
        id: "mintlify-shaped-docs",
        url: "/.well-known/agent-skills/mintlify-shaped-docs/SKILL.md",
      });
      await expect(
        readFile(
          join(
            outDir,
            ".well-known",
            "skills",
            "mintlify-shaped-docs",
            "skill.md"
          ),
          "utf-8"
        )
      ).resolves.toBe(skill);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses Mintlify custom skill files instead of generated skill content", async () => {
    const root = await createMintlifyFixture();
    try {
      await mkdir(join(root, ".mintlify", "skills", "payments"), {
        recursive: true,
      });
      await writeFile(
        join(root, "skill.md"),
        "---\nname: Custom Product\ndescription: Custom root skill.\n---\n\n# Custom\n"
      );
      await writeFile(
        join(root, ".mintlify", "skills", "payments", "SKILL.md"),
        "---\nname: Payments\ndescription: Payment workflows.\n---\n\n# Payments\n"
      );
      const project = await scanProject(root);
      const outDir = join(root, "markdown-output");
      await writeLlmsArtifacts(project, outDir);
      const skill = await readFile(join(outDir, "skill.md"), "utf-8");
      const index = JSON.parse(
        await readFile(
          join(outDir, ".well-known", "agent-skills", "index.json"),
          "utf-8"
        )
      );

      expect(project.graph.pages.map((page) => page.id)).not.toContain(
        "skill.md"
      );
      expect(skill).toContain("# Custom");
      expect(
        index.skills.map((item: { name: string }) => item.name)
      ).toStrictEqual(["custom-product", "payments"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("serializes Markdown exports for Accept-header routing", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = withLlmsTxt(await scanProject(root));
      const markdownByRoute = JSON.parse(await buildRuntimeMarkdown(project));
      expect(markdownByRoute["/quickstart"]).toContain(
        "Call `POST /v1/accounts`"
      );
      expect(markdownByRoute["/quickstart"]).not.toContain("Get started");
      expect(markdownByRoute["/api-reference/list-pets"]).toContain(
        "## OpenAPI schema"
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify OpenAPI visibility metadata into routes and navigation", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      const routes = new Set(project.graph.pages.map((page) => page.route));
      const sidebarPages = flattenPages(project.graph.navigation.sidebar);
      const sidebarByRoute = new Map(
        sidebarPages.map((page) => [page.route, page])
      );
      const routeIndexability = new Map(
        project.manifest.routes.map((route) => [route.path, route.indexable])
      );

      expect({
        excludedRoute: routes.has("/api-reference/internal-pets"),
        hiddenIndexable: routeIndexability.get("/api-reference/hidden-pets"),
        hiddenRoute: routes.has("/api-reference/hidden-pets"),
        hiddenSidebar: sidebarByRoute.has("/api-reference/hidden-pets"),
        legacyDeprecated: sidebarByRoute.get("/api-reference/legacy-pets")
          ?.deprecated,
      }).toStrictEqual({
        excludedRoute: false,
        hiddenIndexable: false,
        hiddenRoute: true,
        hiddenSidebar: false,
        legacyDeprecated: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads Mintlify custom.css into the generated theme", async () => {
    const root = await createMintlifyFixture();
    try {
      const project = await scanProject(root);
      await generateRuntime(project);
      const output = await readFile(
        join(root, ".blume", "src", "generated", "app.css"),
        "utf-8"
      );
      expect(project.context.themeFiles).toStrictEqual([
        join(root, "custom.css"),
      ]);
      expect(output).toContain(".mintlify-custom-proof");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify root navigation modes to tabs, selectors, and sidebar variants", async () => {
    const root = await createMintlifyNavigationFixture();
    try {
      const { config } = await loadConfig(root);
      expect(config.navigation.tabs).toStrictEqual([
        { icon: "book-open", label: "Guides", path: "/guides/intro" },
        {
          items: [
            {
              description: "Client libraries.",
              icon: "code",
              label: "SDKs",
              path: "/sdk/js",
            },
          ],
          label: "Developers",
          path: "/sdk/js",
        },
        { label: "API", path: "/api" },
        { label: "Support", path: "https://example.com/support" },
      ]);
      expect(config.navigation.selectors).toStrictEqual([
        {
          items: [{ label: "Resources", path: "/resources/reference" }],
          kind: "dropdown",
          label: "Dropdowns",
        },
        {
          items: [{ label: "Product A", path: "/product-a/overview" }],
          kind: "product",
          label: "Products",
        },
        {
          items: [{ label: "v2", path: "/v2/intro", tag: "Latest" }],
          kind: "version",
          label: "Versions",
        },
        {
          items: [{ label: "en", path: "/en/intro" }],
          kind: "language",
          label: "Languages",
        },
      ]);
      expect(config.navigation.sidebarVariants).toStrictEqual([
        {
          items: [
            { icon: "book-open", items: ["guides/intro"], label: "Guides" },
          ],
          path: "/guides/intro",
        },
        {
          items: [{ icon: "code", items: ["sdk/js"], label: "SDKs" }],
          path: "/sdk/js",
        },
        {
          items: [{ items: ["api/index", "api/list-things"], label: "API" }],
          path: "/api",
        },
        {
          items: [{ items: ["api/index", "api/list-things"], label: "API" }],
          path: "/api/list-things",
        },
        {
          items: [{ items: ["resources/reference"], label: "Resources" }],
          path: "/resources/reference",
        },
        {
          items: [
            {
              items: [{ items: ["product-a/overview"], label: "Guides" }],
              label: "Product A",
            },
          ],
          path: "/product-a/overview",
        },
        {
          items: [{ items: ["v2/intro"], label: "v2" }],
          path: "/v2/intro",
        },
        {
          items: [{ items: ["en/intro"], label: "en" }],
          path: "/en/intro",
        },
      ]);
      expect(config.navigation.chromeVariants).toStrictEqual([
        {
          banner: {
            content: "English docs",
            dismissible: false,
            type: "info",
          },
          footer: {
            links: [
              {
                header: "English resources",
                items: [{ href: "/en/intro", label: "English intro" }],
              },
            ],
            socials: {},
          },
          navbar: {
            links: [{ href: "/en/intro", label: "English docs" }],
            primary: {
              href: "/en/intro",
              label: "Start in English",
              type: "button",
            },
          },
          path: "/en/intro",
        },
      ]);
      expect(config.api.openapi).toStrictEqual([
        { directory: "api", source: "/openapi.json" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps nested Mintlify navigation modes", async () => {
    const root = await createMintlifyNestedNavigationFixture();
    try {
      const { config } = await loadConfig(root);
      expect(config.navigation.tabs).toStrictEqual([
        {
          items: [
            {
              icon: "book-open",
              label: "Guides",
              path: "/guides/quickstart",
            },
            { icon: "code", label: "API Reference", path: "/api-reference" },
          ],
          label: "Documentation",
          path: "/guides/quickstart",
        },
        {
          items: [{ label: "Help", path: "/support" }],
          label: "Resources",
          path: "/support",
        },
      ]);
      expect(config.navigation.sidebarVariants).toStrictEqual([
        {
          items: [
            {
              items: [
                {
                  icon: "book-open",
                  items: ["guides/quickstart", "guides/tutorial"],
                  label: "Guides",
                },
                {
                  icon: "code",
                  items: ["api-reference/index", "api-reference/list-things"],
                  label: "API Reference",
                },
              ],
              label: "Documentation",
            },
          ],
          path: "/guides/quickstart",
        },
        {
          items: [
            {
              items: [
                {
                  icon: "book-open",
                  items: ["guides/quickstart", "guides/tutorial"],
                  label: "Guides",
                },
                {
                  icon: "code",
                  items: ["api-reference/index", "api-reference/list-things"],
                  label: "API Reference",
                },
              ],
              label: "Documentation",
            },
          ],
          path: "/guides/tutorial",
        },
        {
          items: [
            {
              items: [
                {
                  icon: "book-open",
                  items: ["guides/quickstart", "guides/tutorial"],
                  label: "Guides",
                },
                {
                  icon: "code",
                  items: ["api-reference/index", "api-reference/list-things"],
                  label: "API Reference",
                },
              ],
              label: "Documentation",
            },
          ],
          path: "/api-reference",
        },
        {
          items: [
            {
              items: [
                {
                  icon: "book-open",
                  items: ["guides/quickstart", "guides/tutorial"],
                  label: "Guides",
                },
                {
                  icon: "code",
                  items: ["api-reference/index", "api-reference/list-things"],
                  label: "API Reference",
                },
              ],
              label: "Documentation",
            },
          ],
          path: "/api-reference/list-things",
        },
        {
          items: [
            {
              items: [{ items: ["support", "faq"], label: "Help" }],
              label: "Resources",
            },
          ],
          path: "/support",
        },
        {
          items: [
            {
              items: [{ items: ["support", "faq"], label: "Help" }],
              label: "Resources",
            },
          ],
          path: "/faq",
        },
      ]);
      expect(config.api.openapi).toStrictEqual([
        { directory: "api-reference", source: "/openapi.json" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify nested navigation expanded state", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-mintlify-expanded-nav-"));
    try {
      await mkdir(join(root, "guides"), { recursive: true });
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          name: "Expanded navigation",
          navigation: {
            groups: [
              {
                group: "Guides",
                icon: "book-open",
                pages: [
                  "guides/intro",
                  {
                    expanded: false,
                    group: "Collapsed",
                    icon: "lock",
                    pages: ["guides/collapsed"],
                    tag: "SOON",
                  },
                  {
                    expanded: true,
                    group: "Expanded",
                    icon: "sparkles",
                    pages: ["guides/expanded"],
                  },
                ],
                tag: "BETA",
              },
            ],
          },
        })
      );
      await Promise.all(
        ["intro", "collapsed", "expanded"].map((page) =>
          writeFile(
            join(root, "guides", `${page}.mdx`),
            `---\ntitle: ${page}\n---\n`
          )
        )
      );

      const { config } = await loadConfig(root);

      expect(config.navigation.sidebar).toStrictEqual([
        {
          badge: "BETA",
          icon: "book-open",
          items: [
            "guides/intro",
            {
              badge: "SOON",
              collapsed: true,
              icon: "lock",
              items: ["guides/collapsed"],
              label: "Collapsed",
            },
            {
              collapsed: false,
              icon: "sparkles",
              items: ["guides/expanded"],
              label: "Expanded",
            },
          ],
          label: "Guides",
        },
      ]);

      const project = await scanProject(root);
      expect(project.graph.navigation.sidebar).toMatchObject([
        {
          badge: "BETA",
          children: [
            { label: "intro", route: "/guides/intro" },
            {
              badge: "SOON",
              children: [{ label: "collapsed", route: "/guides/collapsed" }],
              collapsed: true,
              icon: "lock",
              label: "Collapsed",
            },
            {
              children: [{ label: "expanded", route: "/guides/expanded" }],
              collapsed: false,
              icon: "sparkles",
              label: "Expanded",
            },
          ],
          icon: "book-open",
          label: "Guides",
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify group roots to clickable sidebar groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-mintlify-root-nav-"));
    try {
      await mkdir(join(root, "guides"), { recursive: true });
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          name: "Root navigation",
          navigation: {
            groups: [
              {
                group: "Guides",
                pages: ["guides/quickstart"],
                root: "guides/index",
              },
            ],
          },
        })
      );
      await writeFile(
        join(root, "guides", "index.mdx"),
        "---\ntitle: Guide home\n---\n"
      );
      await writeFile(
        join(root, "guides", "quickstart.mdx"),
        "---\ntitle: Quickstart\n---\n"
      );

      const { config } = await loadConfig(root);
      expect(config.navigation.sidebar).toStrictEqual([
        {
          items: ["guides/quickstart"],
          label: "Guides",
          root: "guides/index",
        },
      ]);

      const project = await scanProject(root);
      expect(project.graph.navigation.sidebar).toMatchObject([
        {
          children: [{ label: "Quickstart", route: "/guides/quickstart" }],
          label: "Guides",
          route: "/guides",
        },
      ]);
      expect(flattenPages(project.graph.navigation.sidebar)).toStrictEqual([
        { label: "Guides", route: "/guides" },
        { label: "Quickstart", route: "/guides/quickstart" },
      ]);
      expect(
        findBreadcrumbs(project.graph.navigation.sidebar, "/guides/quickstart")
      ).toStrictEqual([
        { label: "Guides", route: "/guides" },
        { label: "Quickstart", route: "/guides/quickstart" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps inherited Mintlify directory listings for group roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-mintlify-directory-nav-"));
    try {
      await Promise.all(
        ["help", "help/api", "help/getting-started"].map((dir) =>
          mkdir(join(root, dir), { recursive: true })
        )
      );
      await writeFile(
        join(root, "docs.json"),
        JSON.stringify({
          $schema: "https://mintlify.com/docs.json",
          name: "Directory navigation",
          navigation: {
            groups: [
              {
                directory: "accordion",
                group: "Help Center",
                pages: [
                  {
                    group: "Getting Started",
                    pages: ["help/getting-started/quickstart"],
                    root: "help/getting-started/index",
                  },
                  {
                    directory: "none",
                    group: "API Reference",
                    pages: ["help/api/reference"],
                    root: "help/api/index",
                  },
                ],
                root: "help/index",
              },
            ],
          },
        })
      );
      await Promise.all(
        [
          "help/index",
          "help/getting-started/index",
          "help/getting-started/quickstart",
          "help/api/index",
          "help/api/reference",
        ].map((page) =>
          writeFile(
            join(root, `${page}.mdx`),
            `---\ntitle: ${page}\ndescription: ${page} description\n---\n`
          )
        )
      );

      const { config } = await loadConfig(root);
      expect(config.navigation.sidebar).toStrictEqual([
        {
          directory: "accordion",
          items: [
            {
              directory: "accordion",
              items: ["help/getting-started/quickstart"],
              label: "Getting Started",
              root: "help/getting-started/index",
            },
            {
              items: ["help/api/reference"],
              label: "API Reference",
              root: "help/api/index",
            },
          ],
          label: "Help Center",
          root: "help/index",
        },
      ]);

      const project = await scanProject(root);
      const rootListing = findDirectoryListing(
        project.graph.navigation.sidebar,
        "/help"
      );
      const inheritedListing = findDirectoryListing(
        project.graph.navigation.sidebar,
        "/help/getting-started"
      );
      const disabledListing = findDirectoryListing(
        project.graph.navigation.sidebar,
        "/help/api"
      );

      expect(rootListing).toMatchObject({
        items: [
          {
            children: [
              {
                label: "help/getting-started/quickstart",
                route: "/help/getting-started/quickstart",
              },
            ],
            label: "Getting Started",
            route: "/help/getting-started",
          },
          {
            children: [
              {
                label: "help/api/reference",
                route: "/help/api/reference",
              },
            ],
            label: "API Reference",
            route: "/help/api",
          },
        ],
        label: "Help Center",
        mode: "accordion",
      });
      expect(inheritedListing).toMatchObject({
        items: [
          {
            label: "help/getting-started/quickstart",
            route: "/help/getting-started/quickstart",
          },
        ],
        label: "Getting Started",
        mode: "accordion",
      });
      expect(disabledListing).toBeNull();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("maps Mintlify AsyncAPI navigation and generates channel pages", async () => {
    const root = await createMintlifyAsyncApiFixture();
    try {
      const { config } = await loadConfig(root);
      expect(config.api.asyncapi).toStrictEqual([
        { directory: "events", source: "/asyncapi.json" },
      ]);

      const project = await scanProject(root);
      expect(project.graph.pages.map((page) => page.route)).toStrictEqual(
        expect.arrayContaining(["/events", "/events/user-updates"])
      );
      expect(project.graph.navigation.sidebar).toMatchObject([
        expect.any(Object),
        expect.any(Object),
        {
          children: [
            { label: "Fixture Events", route: "/events" },
            { label: "User updates", route: "/events/user-updates" },
          ],
          label: "Event Reference",
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("includes AsyncAPI schemas in Mintlify Markdown exports", async () => {
    const root = await createMintlifyAsyncApiFixture();
    try {
      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.route === "/events/user-updates"
      );
      if (!page) {
        throw new Error("AsyncAPI page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);
      expect(markdown).toContain("## AsyncAPI schema");
      expect(markdown).toContain("Source: /asyncapi.json");
      expect(markdown).toContain('"asyncapi":"3.0.0"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders manual asyncapi frontmatter channel pages", async () => {
    const root = await createMintlifyAsyncApiFixture();
    try {
      await writeFile(
        join(root, "manual-channel.mdx"),
        [
          "---",
          "title: Manual channel",
          'asyncapi: "/asyncapi.json userUpdates"',
          "---",
          "",
          "Custom channel notes.",
          "",
        ].join("\n")
      );

      const project = await scanProject(root);
      const page = project.graph.pages.find(
        (candidate) => candidate.id === "manual-channel.mdx"
      );
      if (!page) {
        throw new Error("Manual AsyncAPI page missing from fixture.");
      }
      const markdown = await buildPageMarkdown(project, page);

      expect({
        apiLayout: page.contentType,
        customBeforeGenerated:
          markdown.indexOf("Custom channel notes.") <
          markdown.indexOf("## Operations"),
        message: markdown.includes("### User updated"),
        operation: markdown.includes("### Receive user updates"),
        payload: markdown.includes('name={"userId"}'),
      }).toStrictEqual({
        apiLayout: "api",
        customBeforeGenerated: true,
        message: true,
        operation: true,
        payload: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates request examples for OpenAPI operations", async () => {
    const root = await createMintlifyFixture();
    try {
      const doc = await parseOpenApi(join(root, "openapi.json"));
      const outDir = join(root, "generated-api");
      await generateApiDocs(doc, outDir);
      const output = await readFile(join(outDir, "list-pets.mdx"), "utf-8");
      expect(output).toContain(
        '<Endpoint method="GET" path={"/pets"} server={"https://api.example.com"} requestExampleId="blume-request-example" />'
      );
      expect(output).not.toContain("<ApiPlayground");
      expect(output).toContain(
        '<RequestExample title="List pets" id="blume-request-example">'
      );
      expect(output).toContain("curl --request GET \\");
      expect(output).toContain("--url 'https://api.example.com/pets'");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("applies OpenAPI x-mint content and href overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-href-"));
    try {
      const outDir = join(root, "api-reference");
      const paths = await generateApiDocs(
        {
          info: { title: "Custom API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/legacy": {
              get: {
                operationId: "legacyEndpoint",
                parameters: [
                  {
                    in: "query",
                    name: "include_archived",
                    schema: { type: "boolean" },
                  },
                ],
                responses: { "200": { description: "OK." } },
                summary: "Legacy endpoint",
                "x-mint": {
                  content:
                    "## Prerequisites\n\n<Note>Use this endpoint only for legacy clients.</Note>",
                  href: "/deprecated/endpoints/legacy",
                },
              },
            },
          },
        },
        outDir,
        { rootDir: root }
      );
      const customPath = join(root, "deprecated", "endpoints", "legacy.mdx");
      const defaultPath = join(outDir, "legacy-endpoint.mdx");
      const output = await readFile(customPath, "utf-8");

      expect({
        contentBeforeParameters:
          output.indexOf("## Prerequisites") <
          output.indexOf("<ParameterTable"),
        hasMintlifyComponent: output.includes(
          "<Note>Use this endpoint only for legacy clients.</Note>"
        ),
        includesDefaultPath: paths.includes(defaultPath),
        includesHrefPath: paths.includes(customPath),
      }).toStrictEqual({
        contentBeforeParameters: true,
        hasMintlifyComponent: true,
        includesDefaultPath: false,
        includesHrefPath: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates OpenAPI parameter pills from x-mint and api params config", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-pills-"));
    try {
      const outDir = join(root, "api-reference");
      await generateApiDocs(
        {
          info: { title: "Pill API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/users": {
              post: {
                operationId: "createUser",
                parameters: [
                  {
                    in: "query",
                    name: "email",
                    schema: {
                      nullable: true,
                      readOnly: true,
                      type: "string",
                      "x-internal": "admin",
                      "x-mint": {
                        post: ["indexed"],
                        pre: ["PII"],
                      },
                    },
                  },
                ],
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        properties: {
                          password: {
                            deprecated: true,
                            description: "Temporary password.",
                            type: "string",
                            writeOnly: true,
                          },
                        },
                        type: "object",
                      },
                    },
                  },
                },
                responses: { "201": { description: "Created." } },
                summary: "Create user",
              },
            },
          },
        },
        outDir,
        { params: { post: ["nullable", "x-internal"] } }
      );
      const output = await readFile(join(outDir, "create-user.mdx"), "utf-8");

      expect({
        configuredPost: output.includes(
          '"post":["read-only","nullable","admin","indexed"]'
        ),
        deprecatedBody: output.includes('"deprecated":true'),
        prePill: output.includes('"pre":["PII"]'),
        writeOnlyBody: output.includes('"post":["write-only"]'),
      }).toStrictEqual({
        configuredPost: true,
        deprecatedBody: true,
        prePill: true,
        writeOnlyBody: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates nested OpenAPI schema fields from local refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-schema-"));
    try {
      const outDir = join(root, "api-reference");
      await generateApiDocs(
        {
          components: {
            schemas: {
              AuditFields: {
                properties: {
                  createdAt: {
                    description: "When the record was created.",
                    format: "date-time",
                    type: "string",
                  },
                },
                required: ["createdAt"],
                type: "object",
              },
              Post: {
                properties: {
                  title: {
                    description: "Post title.",
                    type: "string",
                  },
                },
                required: ["title"],
                type: "object",
              },
              Profile: {
                properties: {
                  email: {
                    description: "Primary email address.",
                    type: "string",
                  },
                  tags: {
                    description: "Profile tags.",
                    items: { type: "string" },
                    type: "array",
                  },
                },
                required: ["email"],
                type: "object",
              },
              User: {
                allOf: [
                  { $ref: "#/components/schemas/AuditFields" },
                  {
                    properties: {
                      id: {
                        description: "Stable user identifier.",
                        type: "string",
                      },
                      posts: {
                        description: "Published posts.",
                        items: { $ref: "#/components/schemas/Post" },
                        type: "array",
                      },
                      profile: { $ref: "#/components/schemas/Profile" },
                    },
                    required: ["id", "profile"],
                    type: "object",
                  },
                ],
              },
            },
          },
          info: { title: "Schema API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/users": {
              post: {
                operationId: "createUserWithSchema",
                requestBody: {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        examples: {
                          active: {
                            summary: "Active user",
                            value: { id: "user_123" },
                          },
                          archived: {
                            summary: "Archived user",
                            value: { id: "user_456" },
                          },
                        },
                        schema: { $ref: "#/components/schemas/User" },
                      },
                    },
                    description: "Created.",
                  },
                },
                summary: "Create user with schema",
              },
            },
          },
        },
        outDir
      );
      const output = await readFile(
        join(outDir, "create-user-with-schema.mdx"),
        "utf-8"
      );

      expect({
        arrayChild: output.includes('"name":"posts[].title"'),
        arrayType: output.includes(
          '"name":"posts","post":[],"pre":[],"required":false,"type":"object[]"'
        ),
        examples:
          output.includes("### Active user") &&
          output.includes("### Archived user"),
        localRefChild: output.includes('"name":"profile.email"'),
        primitiveArray:
          output.includes('"name":"profile.tags"') &&
          output.includes('"type":"string[]"'),
        requiredFromAllOf:
          output.includes('"name":"createdAt"') &&
          output.includes('"required":true'),
        responseSchema: output.includes(
          '<ParameterTable title="Response 200 body"'
        ),
      }).toStrictEqual({
        arrayChild: true,
        arrayType: true,
        examples: true,
        localRefChild: true,
        primitiveArray: true,
        requiredFromAllOf: true,
        responseSchema: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates tagged OpenAPI pages under the tag URL segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-tags-"));
    try {
      const outDir = join(root, "api-reference");
      const paths = await generateApiDocs(
        {
          info: { title: "Tagged API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/users": {
              get: {
                operationId: "listUsers",
                responses: { "200": { description: "OK." } },
                summary: "List users",
                tags: ["user-management"],
              },
            },
          },
          tags: [{ name: "user-management", "x-group": "User Management" }],
        },
        outDir
      );
      const groupedPath = join(outDir, "user-management", "list-users.mdx");
      const flatPath = join(outDir, "list-users.mdx");

      expect({
        groupedOutput: paths.includes(groupedPath),
        oldFlatOutput: paths.includes(flatPath),
      }).toStrictEqual({
        groupedOutput: true,
        oldFlatOutput: false,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates Mintlify OpenAPI hidden and deprecated endpoint metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-visibility-"));
    try {
      const outDir = join(root, "api-reference");
      const paths = await generateApiDocs(
        {
          info: { title: "Visibility API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/hidden": {
              get: {
                operationId: "hiddenEndpoint",
                responses: { "200": { description: "OK." } },
                summary: "Hidden endpoint",
                "x-hidden": true,
              },
            },
            "/internal": {
              get: {
                operationId: "internalEndpoint",
                responses: { "200": { description: "OK." } },
                summary: "Internal endpoint",
                "x-excluded": true,
              },
            },
            "/legacy": {
              get: {
                deprecated: true,
                operationId: "legacyEndpoint",
                responses: { "200": { description: "OK." } },
                summary: "Legacy endpoint",
              },
            },
          },
        },
        outDir
      );
      const hiddenPath = join(outDir, "hidden-endpoint.mdx");
      const internalPath = join(outDir, "internal-endpoint.mdx");
      const legacyOutput = await readFile(
        join(outDir, "legacy-endpoint.mdx"),
        "utf-8"
      );
      const hiddenOutput = await readFile(hiddenPath, "utf-8");

      expect({
        deprecatedEndpoint: legacyOutput.includes("deprecated={true}"),
        deprecatedFrontmatter: legacyOutput.includes("deprecated: true"),
        excluded: paths.includes(internalPath),
        hiddenFrontmatter: hiddenOutput.includes("hidden: true"),
        hiddenOutput: paths.includes(hiddenPath),
      }).toStrictEqual({
        deprecatedEndpoint: true,
        deprecatedFrontmatter: true,
        excluded: false,
        hiddenFrontmatter: true,
        hiddenOutput: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses OpenAPI x-group labels in Mintlify navigation", async () => {
    const root = await createMintlifyFixture();
    try {
      const raw = await readFile(join(root, "openapi.json"), "utf-8");
      const spec = JSON.parse(raw);
      spec.tags = [{ name: "pet-store", "x-group": "Pet Store" }];
      spec.paths["/pets"].get.tags = ["pet-store"];
      await writeFile(join(root, "openapi.json"), JSON.stringify(spec));

      const project = await scanProject(root);
      const routes = new Set(project.graph.pages.map((page) => page.route));
      const sidebar = JSON.stringify(project.graph.navigation.sidebar);
      const sidebarRoutes = flattenPages(project.graph.navigation.sidebar).map(
        (page) => page.route
      );

      expect({
        customRoute: routes.has("/api-reference/pet-store/list-pets"),
        oldRoute: routes.has("/api-reference/list-pets"),
        sidebarGroup: sidebar.includes('"label":"Pet Store"'),
        sidebarRoute: sidebarRoutes.includes(
          "/api-reference/pet-store/list-pets"
        ),
      }).toStrictEqual({
        customRoute: true,
        oldRoute: false,
        sidebarGroup: true,
        sidebarRoute: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses OpenAPI x-mint href in Mintlify navigation", async () => {
    const root = await createMintlifyFixture();
    try {
      const raw = await readFile(join(root, "openapi.json"), "utf-8");
      const spec = JSON.parse(raw);
      spec.paths["/pets"].get["x-mint"] = {
        href: "/reference/pets/list",
      };
      await writeFile(join(root, "openapi.json"), JSON.stringify(spec));

      const project = await scanProject(root);
      const routes = new Set(project.graph.pages.map((page) => page.route));
      const sidebarRoutes = flattenPages(project.graph.navigation.sidebar).map(
        (page) => page.route
      );

      expect({
        customRoute: routes.has("/reference/pets/list"),
        oldRoute: routes.has("/api-reference/list-pets"),
        sidebarRoute: sidebarRoutes.includes("/reference/pets/list"),
      }).toStrictEqual({
        customRoute: true,
        oldRoute: false,
        sidebarRoute: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates static OpenAPI request examples without playground auth fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-auth-"));
    try {
      const outDir = join(root, "generated-api");
      await generateApiDocs(
        {
          components: {
            securitySchemes: {
              bearerAuth: {
                scheme: "bearer",
                type: "http",
                "x-default": "demo-token",
              },
            },
          },
          info: { title: "Auth API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/users/{userId}": {
              get: {
                operationId: "getUser",
                parameters: [
                  {
                    in: "path",
                    name: "userId",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: { "200": { description: "OK." } },
                security: [{ bearerAuth: [] }],
                summary: "Get user",
              },
            },
          },
          servers: [{ url: "https://api.example.com/v1" }],
        },
        outDir,
        { examples: { prefill: true } }
      );
      const output = await readFile(join(outDir, "get-user.mdx"), "utf-8");

      expect({
        endpoint: output.includes(
          '<Endpoint method="GET" path={"/users/{userId}"} server={"https://api.example.com/v1"} requestExampleId="blume-request-example" />'
        ),
        noAuthField: !output.includes('"name":"Authorization"'),
        noProxy: !output.includes("proxy={true}"),
        requestExample: output.includes(
          '<RequestExample title="Get user" id="blume-request-example">'
        ),
        requestUrl: output.includes(
          "--url 'https://api.example.com/v1/users/{userId}'"
        ),
        userParam: output.includes('"name":"userId"'),
      }).toStrictEqual({
        endpoint: true,
        noAuthField: true,
        noProxy: true,
        requestExample: true,
        requestUrl: true,
        userParam: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("carries x-mint group metadata into generated API pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-openapi-groups-"));
    try {
      const outDir = join(root, "generated-api");
      await generateApiDocs(
        {
          info: { title: "Grouped API", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/admin/users": {
              post: {
                operationId: "createAdminUser",
                responses: { "201": { description: "Created." } },
                summary: "Create admin user",
                "x-mint": {
                  metadata: {
                    description: "Create a user with admin privileges.",
                    groups: ["admin"],
                    playground: "auth",
                    public: true,
                    sidebarTitle: "Create admin",
                    title: "Create privileged user",
                  },
                },
              },
            },
            "/billing": {
              get: {
                operationId: "getBilling",
                responses: { "200": { description: "OK." } },
                summary: "Get billing",
              },
              "x-mint": {
                groups: ["billing"],
              },
            },
          },
          servers: [{ url: "https://api.example.com" }],
        },
        outDir
      );

      const publicOutput = await readFile(
        join(outDir, "create-admin-user.mdx"),
        "utf-8"
      );
      const restrictedOutput = await readFile(
        join(outDir, "get-billing.mdx"),
        "utf-8"
      );
      expect({
        publicDescription: publicOutput.includes(
          'description: "Create a user with admin privileges."'
        ),
        publicGroups: publicOutput.includes('groups: ["admin"]'),
        publicPlayground: publicOutput.includes('playground: "auth"'),
        publicSidebarTitle: publicOutput.includes(
          'sidebarTitle: "Create admin"'
        ),
        publicTitle: publicOutput.includes('title: "Create privileged user"'),
        restrictedGroups: restrictedOutput.includes('groups: ["billing"]'),
        restrictedPublic: restrictedOutput.includes("public: true"),
        staticEndpointOnly: !publicOutput.includes("<ApiPlayground"),
      }).toStrictEqual({
        publicDescription: true,
        publicGroups: true,
        publicPlayground: true,
        publicSidebarTitle: true,
        publicTitle: true,
        restrictedGroups: true,
        restrictedPublic: false,
        staticEndpointOnly: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("generates AsyncAPI message payload fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-asyncapi-"));
    try {
      await writeAsyncApiFixture(root);
      const doc = await parseAsyncApi(join(root, "asyncapi.json"));
      const outDir = join(root, "generated-events");
      await generateAsyncApiDocs(doc, outDir);
      const output = await readFile(join(outDir, "user-updates.mdx"), "utf-8");
      expect({
        arrayField: output.includes('name={"profile.roles"} type={"string[]"}'),
        description: output.includes("The stable user identifier."),
        heading: output.includes("# User updates"),
        messages: output.includes("## Messages"),
        nestedField: output.includes('name={"profile.displayName"}'),
        oneOfNumber: output.includes(
          'name={"revisions[].value.NumberValue.amount"}'
        ),
        oneOfString: output.includes(
          'name={"revisions[].value.StringValue.text"}'
        ),
        required: output.includes("required={true}"),
        rootArray: output.includes('name={"revisions"} type={"object[]"}'),
        rootField: output.includes('name={"userId"}'),
        rootFieldItem: output.includes('name={"revisions[].field"}'),
      }).toStrictEqual({
        arrayField: true,
        description: true,
        heading: true,
        messages: true,
        nestedField: true,
        oneOfNumber: true,
        oneOfString: true,
        required: true,
        rootArray: true,
        rootField: true,
        rootFieldItem: true,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("page meta schema", () => {
  it("defaults type to doc and draft to false", () => {
    const meta = pageMetaSchema.parse({});
    expect(meta.type).toBe("doc");
    expect(meta.draft).toBeFalsy();
    expect(meta.sidebar.hidden).toBeFalsy();
  });

  it("accepts Mintlify page layout controls", () => {
    const meta = pageMetaSchema.parse({
      hideFooterPagination: true,
      mode: "wide",
      toc: false,
    });

    expect(meta.hideFooterPagination).toBeTruthy();
    expect(meta.mode).toBe("wide");
    expect(meta.toc).toBeFalsy();
  });

  it("accepts Mintlify page metadata controls", () => {
    const meta = pageMetaSchema.parse({
      deprecated: true,
      groups: ["admin"],
      hidden: true,
      hideApiMarker: true,
      noindex: true,
      public: true,
    });

    expect({
      deprecated: meta.deprecated,
      groups: meta.groups,
      hidden: meta.hidden,
      hideApiMarker: meta.hideApiMarker,
      noindex: meta.noindex,
      public: meta.public,
    }).toStrictEqual({
      deprecated: true,
      groups: ["admin"],
      hidden: true,
      hideApiMarker: true,
      noindex: true,
      public: true,
    });
  });

  it("normalizes Mintlify top-level hidden and boost metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "blume-frontmatter-"));
    try {
      await writeFile(
        join(root, "hidden.mdx"),
        [
          "---",
          "title: Hidden page",
          "hidden: true",
          "boost: 0.25",
          "---",
          "",
          "Hidden content.",
        ].join("\n")
      );
      const { pages } = await discoverContent({
        contentRoot: root,
        defaultType: "doc",
        exclude: [],
        include: ["**/*.mdx"],
      });
      const [page] = pages;

      expect({
        hidden: page?.meta.sidebar.hidden,
        noindex: page?.meta.noindex,
        searchBoost: page?.meta.search.boost,
      }).toStrictEqual({
        hidden: true,
        noindex: true,
        searchBoost: 0.25,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe(slugify, () => {
  it("produces github-style slugs", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Spaced  Out  ")).toBe("spaced-out");
  });
});

describe(extractHeadings, () => {
  it("extracts headings and skips fenced code", () => {
    const body = ["# Title", "```", "## Not a heading", "```", "## Real"].join(
      "\n"
    );
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.text)).toStrictEqual(["Title", "Real"]);
  });
});

describe("content graph", () => {
  it("flags duplicate routes", () => {
    const graph = buildContentGraph(
      [
        makePage({ id: "a.mdx", route: "/x", title: "A" }),
        makePage({ id: "b.mdx", route: "/x", title: "B" }),
      ],
      {
        folderMeta: new Map(),
        navigation: blumeConfigSchema.parse({}).navigation,
      }
    );
    expect(
      graph.diagnostics.some((d) => d.code === "BLUME_DUPLICATE_ROUTE")
    ).toBeTruthy();
  });

  it("carries Mintlify API marker and deprecated metadata into navigation", () => {
    const config = blumeConfigSchema.parse({});
    const graph = buildContentGraph(
      [
        makePage({
          id: "legacy.mdx",
          meta: pageMetaSchema.parse({
            api: "GET /legacy",
            deprecated: true,
            hideApiMarker: true,
          }),
          route: "/legacy",
          title: "Legacy",
        }),
      ],
      {
        folderMeta: new Map(),
        navigation: config.navigation,
      }
    );
    const [item] = graph.navigation.sidebar;

    expect(item).toMatchObject({
      apiMethod: undefined,
      deprecated: true,
      kind: "page",
      route: "/legacy",
    });
  });
});

describe("manifest indexability", () => {
  const context = { contentRoot: "/c", root: "/r" } as ProjectContext;

  it("indexes pages by default and respects search.exclude", () => {
    const config = blumeConfigSchema.parse({});
    const pages = [
      makePage({ id: "a.mdx", route: "/a", title: "A" }),
      makePage({
        id: "b.mdx",
        meta: pageMetaSchema.parse({ search: { exclude: true } }),
        route: "/b",
        title: "B",
      }),
    ];
    const graph = buildContentGraph(pages, {
      folderMeta: new Map(),
      navigation: config.navigation,
    });
    const manifest = buildManifest({ config, context, graph });
    const byPath = new Map(manifest.routes.map((r) => [r.path, r.indexable]));
    expect(byPath.get("/a")).toBeTruthy();
    expect(byPath.get("/b")).toBeFalsy();
  });
});

describe("nav utilities", () => {
  const sidebar = [
    { kind: "page" as const, label: "Home", pageId: "i", route: "/" },
    {
      children: [
        {
          kind: "page" as const,
          label: "Deploy",
          pageId: "d",
          route: "/g/deploy",
        },
      ],
      kind: "group" as const,
      label: "Guides",
      route: "/g",
    },
  ];

  it("flattens pages in order", () => {
    expect(flattenPages(sidebar).map((p) => p.route)).toStrictEqual([
      "/",
      "/g",
      "/g/deploy",
    ]);
  });

  it("builds breadcrumb trails", () => {
    expect(findBreadcrumbs(sidebar, "/g/deploy")).toStrictEqual([
      { label: "Guides", route: "/g" },
      { label: "Deploy", route: "/g/deploy" },
    ]);
  });

  it("resolves previous/next", () => {
    const flat = flattenPages(sidebar);
    expect(getPagination(flat, "/").next?.route).toBe("/g");
    expect(getPagination(flat, "/g/deploy").prev?.route).toBe("/g");
  });
});

describe("rss feeds", () => {
  it("returns no feeds without a configured site", () => {
    const pages = [postPage("a", "/blog/a", "blog", { date: "2026-01-01" })];
    expect(buildRssFeeds(makeProject(pages, { deployment: {} }))).toStrictEqual(
      []
    );
  });

  it("returns no feeds when disabled", () => {
    const pages = [postPage("a", "/blog/a", "blog", { date: "2026-01-01" })];
    expect(
      buildRssFeeds(makeProject(pages, { seo: { rss: { enabled: false } } }))
    ).toStrictEqual([]);
  });

  it("builds a feed per content type with matching pages", () => {
    const pages = [
      postPage("doc", "/guide", "doc", {}),
      postPage("post", "/blog/post", "blog", { date: "2026-01-01" }),
      postPage("v1", "/changelog/v1", "changelog", {
        changelog: { date: "2026-02-01" },
      }),
    ];
    const feeds = buildRssFeeds(makeProject(pages));
    expect(feeds.map((f) => f.path)).toStrictEqual([
      "/blog/rss.xml",
      "/changelog/rss.xml",
    ]);
    expect(feeds[0]?.title).toBe("Docs — Blog");
  });

  it("sorts items newest-first and honors the limit", () => {
    const pages = [
      postPage("old", "/blog/old", "blog", { date: "2026-01-01" }),
      postPage("new", "/blog/new", "blog", { date: "2026-03-01" }),
      postPage("mid", "/blog/mid", "blog", { date: "2026-02-01" }),
    ];
    const [feed] = buildRssFeeds(
      makeProject(pages, { seo: { rss: { limit: 2 } } })
    );
    expect(feed?.items.map((i) => i.title)).toStrictEqual(["new", "mid"]);
  });

  it("excludes drafts and hidden pages", () => {
    const pages = [
      postPage("draft", "/blog/draft", "blog", {
        date: "2026-01-01",
        draft: true,
      }),
      postPage("hidden", "/blog/hidden", "blog", {
        date: "2026-01-02",
        sidebar: { hidden: true },
      }),
      postPage("live", "/blog/live", "blog", { date: "2026-01-03" }),
    ];
    const [feed] = buildRssFeeds(makeProject(pages));
    expect(feed?.items.map((i) => i.title)).toStrictEqual(["live"]);
  });

  it("renders escaped RSS 2.0 XML with absolute links and pubDate", () => {
    const pages = [
      postPage("Tom & Jerry", "/blog/post", "blog", { date: "2026-01-01" }),
    ];
    const [feed] = buildRssFeeds(makeProject(pages));
    const xml = renderRssFeed(feed as NonNullable<typeof feed>);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<title>Tom &amp; Jerry</title>");
    expect(xml).toContain("<link>https://example.com/blog/post</link>");
    expect(xml).toContain("<pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain(
      '<atom:link href="https://example.com/blog/rss.xml" rel="self"'
    );
  });
});

describe("structured data", () => {
  it("emits only a WebSite node for the homepage", () => {
    const data = buildStructuredData({
      breadcrumbs: [],
      route: "/",
      siteName: "Docs",
      siteUrl: "https://x.com",
      title: "Home",
    });
    expect(graphOf(data).map((n) => n["@type"])).toStrictEqual(["WebSite"]);
  });

  it("emits a BlogPosting with absolute url, datePublished, and breadcrumbs", () => {
    const data = buildStructuredData({
      breadcrumbs: [{ label: "Blog", route: "/blog" }, { label: "Post" }],
      description: "Hi",
      pageType: "blog",
      published: "2026-01-01",
      route: "/blog/post",
      siteName: "Docs",
      siteUrl: "https://x.com/",
      title: "Post",
    });
    const graph = graphOf(data);
    const article = graph.find((n) => n["@type"] === "BlogPosting");
    expect(article?.url).toBe("https://x.com/blog/post");
    expect(article?.datePublished).toBe("2026-01-01T00:00:00.000Z");
    expect(article?.isPartOf).toStrictEqual({ "@id": "https://x.com#website" });
    expect(graph.some((n) => n["@type"] === "BreadcrumbList")).toBeTruthy();
  });

  it("falls back to relative urls and TechArticle without a site", () => {
    const data = buildStructuredData({
      breadcrumbs: [],
      route: "/guide",
      siteName: "Docs",
      siteUrl: null,
      title: "Guide",
    });
    const graph = graphOf(data);
    expect(graph.map((n) => n["@type"])).toStrictEqual(["TechArticle"]);
    expect(graph[0]?.url).toBe("/guide");
  });

  it("returns null for the homepage without a site", () => {
    expect(
      buildStructuredData({
        breadcrumbs: [],
        route: "/",
        siteName: "Docs",
        siteUrl: null,
        title: "Home",
      })
    ).toBeNull();
  });
});

describe("sitemap", () => {
  it("excludes drafts, hidden, and noindex pages", () => {
    const pages = [
      makePage({ id: "a", route: "/a", title: "A" }),
      makePage({
        id: "b",
        meta: pageMetaSchema.parse({ draft: true }),
        route: "/b",
        title: "B",
      }),
      makePage({
        id: "c",
        meta: pageMetaSchema.parse({ sidebar: { hidden: true } }),
        route: "/c",
        title: "C",
      }),
      makePage({
        id: "d",
        meta: pageMetaSchema.parse({ seo: { noindex: true } }),
        route: "/d",
        title: "D",
      }),
    ];
    const xml = buildSitemap(makeProject(pages)) ?? "";
    expect(xml).toContain("https://example.com/a");
    expect(xml).not.toContain("/b<");
    expect(xml).not.toContain("/c<");
    expect(xml).not.toContain("/d<");
  });

  it("returns null without a site or when disabled", () => {
    const pages = [makePage({ id: "a", route: "/a", title: "A" })];
    expect(buildSitemap(makeProject(pages, { deployment: {} }))).toBeNull();
    expect(
      buildSitemap(makeProject(pages, { seo: { sitemap: false } }))
    ).toBeNull();
  });
});

describe("robots.txt", () => {
  it("allows all crawlers and links the sitemap when a site is set", () => {
    const robots = buildRobots(makeProject([])) ?? "";
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("omits the sitemap line without a site", () => {
    const robots = buildRobots(makeProject([], { deployment: {} })) ?? "";
    expect(robots).toContain("User-agent: *");
    expect(robots).not.toContain("Sitemap:");
  });

  it("returns null when disabled", () => {
    expect(buildRobots(makeProject([], { seo: { robots: false } }))).toBeNull();
  });
});
