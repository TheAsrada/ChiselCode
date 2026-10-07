import { z } from "zod";
import {
  type ChiselExtension,
  defineTool,
  type ExtensionToolContribution,
} from "../../src/extensions/index.js";
import type { ToolHandler, ToolSpec } from "../../src/tools/types.js";

export function fixtureTool(
  name = "inspect",
  spec: Partial<ToolSpec> = {},
): ExtensionToolContribution {
  return defineTool(
    {
      name,
      description: "Inspect fixture workspace state",
      effect: "read",
      permission: "read",
      parallelSafe: true,
      ...spec,
    },
    z.object({}).strict(),
    async () => ({
      data: undefined,
      preview: "Inspect fixture",
      resources: [],
    }),
    async (context) => ({ output: `Workspace: ${context.workspace.root}` }),
  );
}
export function toolExtension(
  id: string,
  tools: ExtensionToolContribution[],
): ChiselExtension {
  return {
    id,
    activate(ctx) {
      for (const tool of tools) ctx.tools.register(tool);
    },
  };
}
export function renamedTool(
  handler: ToolHandler,
  name: string,
): ExtensionToolContribution {
  const { source: _source, guidance: _guidance, ...spec } = handler.spec;
  return {
    spec: { ...spec, name },
    parse: handler.parse.bind(handler),
    prepare: handler.prepare.bind(handler),
    execute: handler.execute.bind(handler),
  };
}
