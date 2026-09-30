import type { z } from "zod";
import type { ToolExecutionResult } from "../types/domain.js";
import type { ToolContext, ToolHandler, ToolPlan, ToolSpec } from "./types.js";
export function defineTool<Input, Prepared>(
  spec: Omit<ToolSpec, "inputSchema">,
  schema: z.ZodType<Input>,
  prepare: (context: ToolContext, input: Input) => Promise<ToolPlan<Prepared>>,
  execute: (
    context: ToolContext,
    plan: ToolPlan<Prepared>,
  ) => Promise<ToolExecutionResult>,
): ToolHandler {
  return {
    spec: { ...spec, inputSchema: schema.toJSONSchema() },
    parse: (input) => schema.parse(input),
    prepare: (context, input) => prepare(context, input as Input),
    execute: (context, plan) => execute(context, plan as ToolPlan<Prepared>),
  };
}
