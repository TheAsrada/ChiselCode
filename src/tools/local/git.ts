import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { defineTool } from "../handler.js";
import type { ToolContext } from "../types.js";

async function git(context: ToolContext, args: string[]) {
  const result = await execa("git", args, {
    cwd: await realpath(context.workspace.root),
    reject: false,
    all: true,
    cancelSignal: context.signal,
  });
  return {
    output: result.all || `(exit ${result.exitCode})`,
    isError: result.exitCode !== 0,
  };
}
export function gitHandlers() {
  return [
    defineTool(
      {
        name: "git_status",
        description: "Read working tree status.",
        effect: "read",
        permission: "read",
        parallelSafe: true,
      },
      z.object({}),
      async () => ({ data: {}, preview: "git status", resources: [] }),
      (context) => git(context, ["status", "--short"]),
    ),
    defineTool(
      {
        name: "git_diff",
        description: "Read unstaged/staged/all Git changes.",
        effect: "read",
        permission: "read",
        parallelSafe: true,
      },
      z.object({
        scope: z.enum(["unstaged", "staged", "all"]).default("unstaged"),
        path: z.string().optional(),
      }),
      async (context, input) => {
        if (input.path?.startsWith(":"))
          throw new Error("Git pathspec magic is not supported.");
        const path = input.path
          ? relative(
              await realpath(context.workspace.root),
              await context.workspace.resolve(input.path),
            )
          : undefined;
        return {
          data: { ...input, path },
          preview: "git diff",
          resources: path ? [path] : [],
        };
      },
      (context, { data }) =>
        git(context, [
          "diff",
          ...(data.scope === "staged"
            ? ["--cached"]
            : data.scope === "all"
              ? ["HEAD"]
              : []),
          "--",
          ...(data.path ? [data.path] : []),
        ]),
    ),
    defineTool(
      {
        name: "git_commit",
        description: "Commit staged changes with approval.",
        effect: "git_write",
        permission: "git",
        parallelSafe: false,
      },
      z.object({ message: z.string().min(1).max(500) }),
      async (_context, input) => ({
        data: input,
        preview: `git commit -m ${JSON.stringify(input.message)}`,
        resources: [],
      }),
      (context, { data }) => git(context, ["commit", "-m", data.message]),
    ),
  ];
}
