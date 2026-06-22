import { defineCommand } from "citty";
import { resolve } from "pathe";

import { generateApiDocs, parseOpenApi } from "../../openapi/import.ts";
import { logger } from "../log.ts";

const openapiCommand = defineCommand({
  args: {
    out: {
      default: "docs/api",
      description: "Output directory for generated MDX.",
      type: "string",
    },
    spec: {
      description: "Path to the OpenAPI JSON or YAML spec.",
      required: true,
      type: "positional",
    },
  },
  meta: {
    description: "Generate MDX reference pages from an OpenAPI spec.",
    name: "openapi",
  },
  async run({ args }) {
    const root = process.cwd();
    const doc = await parseOpenApi(resolve(root, args.spec));
    const files = await generateApiDocs(doc, resolve(root, args.out));
    logger.success(`Generated ${files.length} API page(s) in ${args.out}`);
  },
});

export const importCommand = defineCommand({
  meta: {
    description: "Import external content (e.g. OpenAPI) into Blume.",
    name: "import",
  },
  subCommands: {
    openapi: openapiCommand,
  },
});
