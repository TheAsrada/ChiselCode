import { z } from "zod";
import { RuntimeError } from "../../runtime/errors.js";
import { defineTool } from "../../tools/handler.js";
import { executeWorktreePlan } from "../../worktrees/capability.js";
import {
  type WorktreeAction,
  type WorktreeDescriptor,
  WorktreeService,
  type WorktreeWorkspacePort,
} from "../../worktrees/service.js";
import type { ChiselExtension } from "../contracts.js";
import { createServiceToken } from "../services.js";

export const worktreeServiceToken = createServiceToken<WorktreeWorkspacePort>(
  "builtin.worktrees.service",
);
const id = z.uuid();
const paths = z.array(z.string().min(1)).min(1).max(200).optional();
const label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      [...value].every((char) => {
        const code = char.charCodeAt(0);
        return code >= 32 && (code < 127 || code > 159);
      }),
    "Use plain text for the label.",
  );
const states: Record<string, string> = {
  ready: "Готова",
  creating: "Создание не завершено",
  removing: "Удаление не завершено",
  removed: "Удалена",
  missing: "Не найдена",
  recovery_required: "Нужна проверка",
  failed: "Не создана",
  external: "Внешняя (только просмотр)",
};
function describe(item: WorktreeDescriptor): string {
  return `${item.label} · ${states[item.state] ?? item.state}\n${item.id ? `ID: ${item.id}\n` : ""}Path: ${item.path}\n${item.base ? `Base: ${item.base}\n` : ""}${item.head ? `HEAD: ${item.head}${item.head !== item.base ? " (есть commit-result)" : ""}\n` : ""}${item.staged !== undefined ? `Изменения: staged ${item.staged}, unstaged ${item.unstaged}, новые ${item.untracked}, ignored ${item.ignored}, conflicts ${item.conflicted}\n` : ""}${item.activeUsers ? `Открыта: ${item.activeUsers} пользователей\n` : ""}${item.reason ?? ""}${item.retainedRef ? `\nСохранённый результат: ${item.retainedRef}` : ""}`.trim();
}
interface Parsed {
  action: WorktreeAction | "open";
  id?: string;
  label?: string;
  ref?: string;
  paths?: string[];
}
export function parseWorktreeCommand(args: string): Parsed {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!match) return { action: "list" };
  const action = match[1];
  const rest = match[2]?.trim() ?? "";
  if (action === "create") {
    const withRef = /^--ref\s+(\S+)\s+([\s\S]+)$/.exec(rest);
    return {
      action,
      label: label.parse(withRef?.[2] ?? rest),
      ref: withRef?.[1],
    };
  }
  if (action === "list" && !rest) return { action };
  if (["status", "diff", "apply", "remove", "open"].includes(action ?? "")) {
    const value = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    const selected = value?.[2]?.trim();
    if (selected && action !== "diff" && action !== "apply")
      throw new Error("Unexpected arguments.");
    return {
      action: action as Parsed["action"],
      id: id.parse(value?.[1]),
      paths: selected ? [selected] : undefined,
    };
  }
  throw new Error("Unknown worktree action.");
}
export function createWorktreeExtension(
  service = new WorktreeService(),
): ChiselExtension {
  return {
    id: "builtin.worktrees",
    async activate(ctx) {
      const port = service.workspace(ctx.workspaceRoot, ctx.signal);
      ctx.services.provide(worktreeServiceToken, port);
      // Register before LSP in default composition: reverse cleanup shuts down
      // processes/scopes before releasing their durable use lease.
      ctx.add(await service.acquireUse(ctx.workspaceRoot));
      for (const action of [
        "list",
        "status",
        "create",
        "diff",
        "apply",
        "remove",
      ] as const) {
        const schema =
          action === "list"
            ? z.object({}).strict()
            : action === "create"
              ? z
                  .object({ label, ref: z.string().min(1).max(256).optional() })
                  .strict()
              : action === "diff" || action === "apply"
                ? z.object({ id, paths }).strict()
                : z.object({ id }).strict();
        ctx.tools.register(
          defineTool(
            {
              name: action,
              description: `${action} managed detached Git worktrees. create starts from committed HEAD/local ref without copying dirty files; diff/apply compare final files to immutable base including commits/staging/new files. apply only targets recorded origin and rejects conflicts/stale/unsupported items. remove never discards dirty/ignored files or active users; retains commit results. Paths/ownership are core-selected. Use list for IDs.`,
              effect:
                action === "apply"
                  ? "workspace_write"
                  : action === "create" || action === "remove"
                    ? "git_write"
                    : "read",
              permission:
                action === "apply"
                  ? "write"
                  : action === "create" || action === "remove"
                    ? "git"
                    : "read",
              workspaceAccess:
                action === "create" || action === "remove" || action === "apply"
                  ? "write"
                  : "read",
              parallelSafe: false,
              timeoutMs: 120_000,
            },
            schema as z.ZodType<
              import("../../worktrees/service.js").WorktreeInput
            >,
            async (context, input) => {
              if (!context.worktrees)
                throw new RuntimeError(
                  "WORKTREE_UNAVAILABLE",
                  "Worktree service is not attached.",
                );
              return context.worktrees.prepare(action, input, context);
            },
            async (context, plan) => {
              const result = await executeWorktreePlan(context, plan);
              if (
                action === "list" ||
                action === "status" ||
                action === "create" ||
                action === "remove"
              ) {
                const data = JSON.parse(result.output);
                if (action === "list")
                  return {
                    ...result,
                    output:
                      (data as WorktreeDescriptor[])
                        .map(describe)
                        .join("\n\n") ||
                      "Рабочих копий нет. /worktree create <название>",
                    details: { worktrees: data },
                  };
                if (action === "remove")
                  return {
                    ...result,
                    output: `Рабочая копия ${data.id} удалена.${data.retainedRef ? `\nCommit-result сохранён: ${data.retainedCommit}\nВосстановление: ${data.recovery}` : ""}`,
                    details: { worktree: data },
                  };
                return {
                  ...result,
                  output: `${describe(data)}\nОткрыть: /worktree open ${data.id}`,
                  details: { worktree: data },
                };
              }
              return result;
            },
          ),
        );
      }
      ctx.commands.register({
        name: "worktree",
        description:
          "Изолированные рабочие копии: создать, открыть, проверить, применить и безопасно удалить",
        usage:
          "/worktree [list | create [--ref REF] название | status ID | diff ID [path] | open ID | apply ID [path] | remove ID]",
        parse: parseWorktreeCommand,
        execute: (context, input) =>
          input.action === "open"
            ? context.worktrees.open(input.id as string)
            : context.tools.execute(
                `ext:builtin.worktrees:${input.action}`,
                Object.fromEntries(
                  Object.entries(input).filter(
                    ([key, value]) => key !== "action" && value !== undefined,
                  ),
                ) as import("../../types/domain.js").JsonObject,
              ),
      });
    },
  };
}
