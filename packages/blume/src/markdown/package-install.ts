import { codeBlock, jsxAttribute, jsxFlowElement } from "./mdast.ts";
import type { MdastNode, MdastVisitorContext } from "./mdast.ts";
import { PACKAGE_MANAGERS, toPackageCommands } from "./package-commands.ts";

interface CodeNode extends MdastNode {
  lang?: string | null;
  value: string;
}

/** Build an `<Tab title="...">` node wrapping a single highlighted command. */
const tabNode = (manager: string, command: string) =>
  jsxFlowElement(
    "Tab",
    [jsxAttribute("title", manager)],
    [codeBlock("bash", command)]
  );

/**
 * Satteri MDAST plugin that turns a ` ```package-install ` code block into a
 * `<Tabs>` group with one `<Tab>` per package manager, each holding the
 * converted install command as a normal (highlighted) code block. Runs at the
 * MDAST stage so the generated code blocks are highlighted like any other.
 */
export const packageInstallPlugin = () => ({
  code(node: CodeNode, ctx: MdastVisitorContext) {
    if (node.lang !== "package-install") {
      return;
    }
    const commands = toPackageCommands(node.value);
    ctx.replaceNode(
      node,
      jsxFlowElement(
        "Tabs",
        // hash off: clicking "pnpm" in an install block must not rewrite the
        // page hash (clobbering the heading anchor the reader arrived with).
        [jsxAttribute("hash", "false")],
        PACKAGE_MANAGERS.map((manager) => tabNode(manager, commands[manager]))
      )
    );
  },
  name: "blume-package-install",
});
