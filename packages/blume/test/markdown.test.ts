import { describe, expect, it } from "vitest";

import { codeTitleTransformer } from "../src/markdown/code-title.ts";
import { calloutTypeFor } from "../src/markdown/directives.ts";
import { mermaidPlugin } from "../src/markdown/mermaid.ts";
import { mintlifyCodeGroupPlugin } from "../src/markdown/mintlify-code-group.ts";
import {
  rewriteMintlifyGlobalVariables,
  rewriteMintlifyMarkdownSnippets,
  rewriteMintlifySnippetVariables,
  rewriteMintlifyUserVariable,
} from "../src/markdown/mintlify-snippets.ts";
import {
  mintlifySvgIconPlugin,
  rewriteMintlifySvgIconProps,
} from "../src/markdown/mintlify-svg-icons.ts";
import { toPackageCommands } from "../src/markdown/package-commands.ts";

/** Run the code-meta transformer over a fence's meta and return the <pre> attrs. */
const metaAttrs = (
  raw: string | undefined
): Record<string, boolean | number | string | undefined> => {
  const node = {
    properties: {} as Record<string, boolean | number | string | undefined>,
  };
  codeTitleTransformer().pre.call({ options: { meta: { __raw: raw } } }, node);
  return node.properties;
};

describe(calloutTypeFor, () => {
  it("passes through canonical callout types", () => {
    expect(calloutTypeFor("note")).toBe("note");
    expect(calloutTypeFor("warning")).toBe("warning");
    expect(calloutTypeFor("tip")).toBe("tip");
  });

  it("resolves aliases", () => {
    expect(calloutTypeFor("caution")).toBe("warning");
    expect(calloutTypeFor("error")).toBe("danger");
    expect(calloutTypeFor("important")).toBe("note");
  });

  it("is case-insensitive", () => {
    expect(calloutTypeFor("NOTE")).toBe("note");
  });

  it("returns null for non-callout directives", () => {
    expect(calloutTypeFor("details")).toBeNull();
  });
});

describe(toPackageCommands, () => {
  it("treats a bare package list as an install", () => {
    expect(toPackageCommands("react react-dom")).toStrictEqual({
      bun: "bun add react react-dom",
      npm: "npm install react react-dom",
      pnpm: "pnpm add react react-dom",
      yarn: "yarn add react react-dom",
    });
  });

  it("converts an explicit npm install with a dev flag", () => {
    expect(toPackageCommands("npm i -D typescript")).toStrictEqual({
      bun: "bun add -D typescript",
      npm: "npm install -D typescript",
      pnpm: "pnpm add -D typescript",
      yarn: "yarn add -D typescript",
    });
  });

  it("normalizes --save-dev to -D", () => {
    expect(toPackageCommands("npm install --save-dev vitest").pnpm).toBe(
      "pnpm add -D vitest"
    );
  });

  it("handles a bare `npm install` as install-all", () => {
    expect(toPackageCommands("npm install")).toStrictEqual({
      bun: "bun install",
      npm: "npm install",
      pnpm: "pnpm install",
      yarn: "yarn install",
    });
  });

  it("maps npx to each manager's exec command", () => {
    expect(toPackageCommands("npx astro add react")).toStrictEqual({
      bun: "bunx astro add react",
      npm: "npx astro add react",
      pnpm: "pnpm dlx astro add react",
      yarn: "yarn dlx astro add react",
    });
  });

  it("maps create/init", () => {
    expect(toPackageCommands("npm create astro@latest")).toStrictEqual({
      bun: "bun create astro@latest",
      npm: "npm create astro@latest",
      pnpm: "pnpm create astro@latest",
      yarn: "yarn create astro@latest",
    });
  });

  it("routes global installs through yarn global add", () => {
    expect(toPackageCommands("npm i -g vercel")).toStrictEqual({
      bun: "bun add -g vercel",
      npm: "npm install -g vercel",
      pnpm: "pnpm add -g vercel",
      yarn: "yarn global add vercel",
    });
  });

  it("maps uninstall to remove", () => {
    expect(toPackageCommands("npm uninstall lodash")).toStrictEqual({
      bun: "bun remove lodash",
      npm: "npm uninstall lodash",
      pnpm: "pnpm remove lodash",
      yarn: "yarn remove lodash",
    });
  });

  it("keeps run scripts on each manager", () => {
    expect(toPackageCommands("npm run build").yarn).toBe("yarn run build");
  });
});

describe(mintlifyCodeGroupPlugin, () => {
  it("wraps Mintlify CodeGroup code fences in titled tabs", () => {
    const plugin = mintlifyCodeGroupPlugin();
    let replacement: unknown;

    plugin.mdxJsxFlowElement(
      {
        attributes: [],
        children: [
          {
            lang: "javascript",
            meta: "helloWorld.js",
            type: "code",
            value: 'console.log("Hello World");',
          },
        ],
        name: "CodeGroup",
        type: "mdxJsxFlowElement",
      },
      {
        replaceNode: (_node, next) => {
          replacement = next;
        },
      }
    );

    expect(replacement).toStrictEqual({
      attributes: [],
      children: [
        {
          attributes: [
            {
              name: "title",
              type: "mdxJsxAttribute",
              value: "helloWorld.js",
            },
          ],
          children: [
            {
              lang: "javascript",
              meta: "helloWorld.js",
              type: "code",
              value: 'console.log("Hello World");',
            },
          ],
          name: "Tab",
          type: "mdxJsxFlowElement",
        },
      ],
      name: "CodeGroup",
      type: "mdxJsxFlowElement",
    });
  });

  it("wraps Mintlify API example code fences in titled tabs", () => {
    const plugin = mintlifyCodeGroupPlugin();
    let replacement: unknown;

    plugin.mdxJsxFlowElement(
      {
        attributes: [
          {
            name: "dropdown",
            type: "mdxJsxAttribute",
            value: null,
          },
        ],
        children: [
          {
            lang: "bash",
            meta: "Request",
            type: "code",
            value: "curl https://api.example.com/users",
          },
          {
            lang: "javascript",
            meta: 'title="JavaScript"',
            type: "code",
            value: "await fetch('/users')",
          },
        ],
        name: "RequestExample",
        type: "mdxJsxFlowElement",
      },
      {
        replaceNode: (_node, next) => {
          replacement = next;
        },
      }
    );

    expect(replacement).toStrictEqual({
      attributes: [
        {
          name: "dropdown",
          type: "mdxJsxAttribute",
          value: null,
        },
      ],
      children: [
        {
          attributes: [
            {
              name: "title",
              type: "mdxJsxAttribute",
              value: "Request",
            },
          ],
          children: [
            {
              lang: "bash",
              meta: "Request",
              type: "code",
              value: "curl https://api.example.com/users",
            },
          ],
          name: "Tab",
          type: "mdxJsxFlowElement",
        },
        {
          attributes: [
            {
              name: "title",
              type: "mdxJsxAttribute",
              value: "JavaScript",
            },
          ],
          children: [
            {
              lang: "javascript",
              meta: 'title="JavaScript"',
              type: "code",
              value: "await fetch('/users')",
            },
          ],
          name: "Tab",
          type: "mdxJsxFlowElement",
        },
      ],
      name: "RequestExample",
      type: "mdxJsxFlowElement",
    });
  });
});

describe(mintlifySvgIconPlugin, () => {
  it("rewrites source-level custom SVG icon props", () => {
    const source = `<Badge
  icon={
    <svg viewBox="0 0 24 24" width={12} height={12}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  }
  color="purple"
>
  Custom
</Badge>`;

    expect(rewriteMintlifySvgIconProps(source)).toBe(`<Badge
  icon={"<svg viewBox=\\"0 0 24 24\\" width=\\"12\\" height=\\"12\\">\\n      <circle cx=\\"12\\" cy=\\"12\\" r=\\"9\\" />\\n    </svg>"}
  color="purple"
>
  Custom
</Badge>`);
  });

  it("rewrites custom SVG icon props to static SVG strings", () => {
    const plugin = mintlifySvgIconPlugin();
    const node = {
      attributes: [
        {
          name: "icon",
          type: "mdxJsxAttribute",
          value: {
            type: "mdxJsxAttributeValueExpression",
            value:
              '<svg viewBox="0 0 24 24" width={12} height={12}><path strokeLinecap="round" d="M4 12h16" /></svg>',
          },
        },
      ],
      children: [],
      name: "Badge",
      type: "mdxJsxTextElement",
    };

    plugin.mdxJsxTextElement(node);

    expect(node.attributes[0]).toStrictEqual({
      name: "icon",
      type: "mdxJsxAttribute",
      value:
        '<svg viewBox="0 0 24 24" width="12" height="12"><path stroke-linecap="round" d="M4 12h16" /></svg>',
    });
  });
});

describe(rewriteMintlifyMarkdownSnippets, () => {
  it("inlines Mintlify markdown snippets with prop interpolation", async () => {
    const source = [
      'import InstallSnippet from "/snippets/install.md";',
      "",
      '<InstallSnippet packageName="@acme/sdk" />',
    ].join("\n");
    const files = new Map([
      [
        "/project/snippets/install.md",
        [
          "Install the package:",
          "",
          "```bash",
          "npm install {packageName}",
          "```",
        ].join("\n"),
      ],
    ]);

    await expect(
      rewriteMintlifyMarkdownSnippets(source, {
        filePath: "/project/page.mdx",
        readFile: (file) => Promise.resolve(files.get(file) ?? ""),
        root: "/project",
      })
    ).resolves.toBe(
      [
        "",
        "Install the package:",
        "",
        "```bash",
        "npm install @acme/sdk",
        "```",
      ].join("\n")
    );
  });

  it("inlines nested Mintlify markdown snippets", async () => {
    const source = [
      'import ParentSnippet from "/snippets/parent.mdx";',
      "",
      '<ParentSnippet label="nested" />',
    ].join("\n");
    const files = new Map([
      [
        "/project/snippets/parent.mdx",
        [
          'import ChildSnippet from "./child.mdx";',
          "",
          "Parent content.",
          "",
          '<ChildSnippet label="{label}" />',
        ].join("\n"),
      ],
      ["/project/snippets/child.mdx", "Child content: {label}."],
    ]);

    await expect(
      rewriteMintlifyMarkdownSnippets(source, {
        filePath: "/project/page.mdx",
        readFile: (file) => Promise.resolve(files.get(file) ?? ""),
        root: "/project",
      })
    ).resolves.toContain("Child content: nested.");
  });

  it("inlines paired Mintlify markdown snippet invocations", async () => {
    const source = [
      'import DetailSnippet from "/snippets/detail.mdx";',
      "",
      '<DetailSnippet label="paired">Fallback content.</DetailSnippet>',
    ].join("\n");
    const files = new Map([
      ["/project/snippets/detail.mdx", "Snippet content: {label}."],
    ]);

    await expect(
      rewriteMintlifyMarkdownSnippets(source, {
        filePath: "/project/page.mdx",
        readFile: (file) => Promise.resolve(files.get(file) ?? ""),
        root: "/project",
      })
    ).resolves.toBe(["", "Snippet content: paired."].join("\n"));
  });

  it("reports circular Mintlify markdown snippet imports", async () => {
    const source = [
      'import ParentSnippet from "/snippets/parent.mdx";',
      "",
      "<ParentSnippet />",
    ].join("\n");
    const files = new Map([
      [
        "/project/snippets/parent.mdx",
        [
          'import ChildSnippet from "./child.mdx";',
          "",
          "<ChildSnippet />",
        ].join("\n"),
      ],
      [
        "/project/snippets/child.mdx",
        [
          'import ParentSnippet from "./parent.mdx";',
          "",
          "<ParentSnippet />",
        ].join("\n"),
      ],
    ]);

    await expect(
      rewriteMintlifyMarkdownSnippets(source, {
        filePath: "/project/page.mdx",
        readFile: (file) => Promise.resolve(files.get(file) ?? ""),
        root: "/project",
      })
    ).rejects.toThrow(
      "Circular Mintlify snippet import detected: /snippets/parent.mdx -> /snippets/child.mdx -> /snippets/parent.mdx"
    );
  });
});

describe(rewriteMintlifySnippetVariables, () => {
  it("resolves imported Mintlify snippet string constants", async () => {
    const source = [
      'import { installCommand, packageName as pkg } from "/snippets/vars.mdx";',
      "",
      "Install **{pkg}** with <code>{installCommand}</code>.",
    ].join("\n");
    const files = new Map([
      [
        "/project/snippets/vars.mdx",
        [
          'export const packageName = "blume";',
          'export const installCommand = "bun add blume";',
        ].join("\n"),
      ],
    ]);

    await expect(
      rewriteMintlifySnippetVariables(source, {
        filePath: "/project/page.mdx",
        readFile: (file) => Promise.resolve(files.get(file) ?? ""),
        root: "/project",
      })
    ).resolves.toContain("Install **blume** with <code>bun add blume</code>.");
  });
});

describe(rewriteMintlifyGlobalVariables, () => {
  it("replaces docs.json variables and leaves unknown placeholders intact", () => {
    expect(
      rewriteMintlifyGlobalVariables(
        "Welcome to {{product-name}}. Keep {{missing}}.",
        { "product-name": "Blume Garden" }
      )
    ).toBe("Welcome to Blume Garden. Keep {{missing}}.");
  });

  it("does not consume single-brace snippet placeholders", () => {
    expect(
      rewriteMintlifyGlobalVariables(
        "Install {packageName} for {{product-name}}.",
        { "product-name": "Blume Garden" }
      )
    ).toBe("Install {packageName} for Blume Garden.");
  });
});

describe(rewriteMintlifyUserVariable, () => {
  it("injects a logged-out user export after frontmatter", () => {
    expect(
      rewriteMintlifyUserVariable(
        "---\ntitle: Personalized\n---\n\nWelcome, {user.firstName}."
      )
    ).toBe(
      "---\ntitle: Personalized\n---\nexport const user = {};\n\nWelcome, {user.firstName}."
    );
  });

  it("keeps author-provided user bindings", () => {
    const source =
      "export const user = { firstName: 'Jane' };\n\n{user.firstName}";
    expect(rewriteMintlifyUserVariable(source)).toBe(source);
  });
});

describe(mermaidPlugin, () => {
  it("turns mermaid code fences into a blume-mermaid element", () => {
    const plugin = mermaidPlugin();
    let replacement: unknown;

    plugin.code(
      {
        lang: "mermaid",
        type: "code",
        value: "flowchart LR\n  A --> B",
      },
      {
        replaceNode: (_node, next) => {
          replacement = next;
        },
      }
    );

    expect(replacement).toStrictEqual({
      attributes: [
        {
          name: "class",
          type: "mdxJsxAttribute",
          value: "not-prose my-6 flex justify-center overflow-x-auto",
        },
        {
          name: "data-source",
          type: "mdxJsxAttribute",
          value: "flowchart LR\n  A --> B",
        },
      ],
      children: [],
      name: "blume-mermaid",
      type: "mdxJsxFlowElement",
    });
  });
});

describe(codeTitleTransformer, () => {
  it("promotes the first bare token to a title", () => {
    expect(metaAttrs("blume.config.ts").dataTitle).toBe("blume.config.ts");
  });

  it("reads an explicit title attribute", () => {
    expect(metaAttrs('title="My File"').dataTitle).toBe("My File");
  });

  it("sets data-line-numbers and keeps the title", () => {
    const attrs = metaAttrs("file.ts lineNumbers");
    expect(attrs.dataTitle).toBe("file.ts");
    expect(attrs.dataLineNumbers).toBeTruthy();
  });

  it("does not treat the lineNumbers keyword as a title", () => {
    const attrs = metaAttrs("lineNumbers");
    expect(attrs.dataTitle).toBeUndefined();
    expect(attrs.dataLineNumbers).toBeTruthy();
  });

  it("ignores line ranges and leaves plain blocks bare", () => {
    expect(metaAttrs("{1,3-5}").dataTitle).toBeUndefined();
    expect(metaAttrs().dataLineNumbers).toBeUndefined();
  });
});
