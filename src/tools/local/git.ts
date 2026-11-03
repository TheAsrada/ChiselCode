import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import { gitCommand } from "../../git/driver.js";
import { RuntimeError } from "../../runtime/errors.js";
import type { ToolExecutionResult } from "../../types/domain.js";
import { defineTool } from "../handler.js";
import type { ToolContext } from "../types.js";

async function git(context: ToolContext, args: string[]) {
  return {
    isError: false,
    output:
      (await gitCommand(context.workspace.root, args, context.signal)) ||
      "Git operation completed.",
  };
}
async function gitRead(
  operation: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== "GIT_NOT_REPOSITORY")
      throw error;
    return {
      output: error.message,
      isError: false,
      details: { git: { available: false, reason: "not_repository" } },
    };
  }
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
      (context) =>
        gitRead(() =>
          git(context, ["--no-optional-locks", "status", "--short", "--", "."]),
        ),
    ),
    defineTool(
      {
        name: "git_diff",
        description:
          "Read unstaged/staged/all tracked Git changes within the project. Untracked files appear in git_status; read them with read_file. Works before the first commit.",
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
        gitRead(async () => {
          const diff = (revision: string[]) =>
            gitCommand(
              context.workspace.root,
              [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                ...revision,
                "--",
                data.path || ".",
              ],
              context.signal,
            );
          const hasHead =
            data.scope === "all" &&
            (await gitCommand(
              context.workspace.root,
              ["rev-parse", "--verify", "--quiet", "HEAD"],
              context.signal,
              true,
            ));
          // An unborn branch has no HEAD to diff against. Read the index and
          // worktree separately, without staging files or creating a commit.
          const output =
            data.scope === "all" && !hasHead
              ? (await diff(["--cached"])) + (await diff([]))
              : await diff(
                  data.scope === "staged"
                    ? ["--cached"]
                    : data.scope === "all"
                      ? ["HEAD"]
                      : [],
                );
          return {
            isError: false,
            output:
              output ||
              "Нет изменений отслеживаемых файлов. Новые файлы смотрите через git_status и read_file.",
          };
        }),
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
