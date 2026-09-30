import { z } from "zod";
import { defineTool } from "../handler.js";
import type { ToolContext, ToolPlan } from "../types.js";
import type { PatchPlan } from "./patch-plan.js";

async function prepared(plan: PatchPlan): Promise<ToolPlan<PatchPlan>> {
  return {
    data: plan,
    preview: plan.diffs.map((diff) => diff.patch).join("\n"),
    resources: plan.permissionResources,
    diffs: plan.diffs,
  };
}
async function execute(context: ToolContext, plan: ToolPlan<PatchPlan>) {
  const result = await context.editing.commit(plan.data, context.signal);
  for (const change of result.changes)
    context.session.undoStack.push({
      ...change,
      createdAt: new Date().toISOString(),
    });
  return {
    output: result.modelMessage,
    fileDiff: result.diffs[0],
    diffs: result.diffs,
    preview: plan.preview,
  };
}
const spec = {
  effect: "workspace_write" as const,
  permission: "edit",
  parallelSafe: false,
};
export function editingHandlers() {
  return [
    defineTool(
      {
        ...spec,
        name: "write_file",
        description:
          "Create or replace a small file; overwrites require a fresh observed revision.",
      },
      z.object({ path: z.string().min(1), content: z.string() }),
      async (context, input) =>
        prepared(await context.editing.write(input.path, input.content)),
      execute,
    ),
    defineTool(
      {
        ...spec,
        name: "edit_file",
        description: "Replace one unique exact string in a freshly read file.",
      },
      z.object({
        path: z.string().min(1),
        old_str: z.string().min(1),
        new_str: z.string(),
      }),
      async (context, input) =>
        prepared(
          await context.editing.edit(input.path, input.old_str, input.new_str),
        ),
      execute,
    ),
    defineTool(
      {
        ...spec,
        name: "delete_file",
        description: "Delete a freshly read file with approval.",
      },
      z.object({ path: z.string().min(1) }),
      async (context, input) =>
        prepared(await context.editing.delete(input.path)),
      execute,
    ),
    defineTool(
      {
        ...spec,
        name: "apply_patch",
        description:
          "Apply a complete *** Begin Patch / End Patch envelope with Add/Update/Delete File, optional Move to, and @@ hunks. All files are preflighted before any write; existing files need fresh reads.",
      },
      z.object({ patchText: z.string().min(1) }),
      async (context, input) =>
        prepared(await context.editing.patch(input.patchText)),
      execute,
    ),
  ];
}
