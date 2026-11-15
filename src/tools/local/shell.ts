import { attestNativeShell } from "../../background/capability.js";
import { type ShellData, ShellInputSchema } from "../../background/input.js";
import { shellGuidance } from "../../processes/shell.js";
import { RuntimeError } from "../../runtime/errors.js";
import { defineTool } from "../handler.js";
import { shellResult } from "../shell-result.js";
export function shellHandler() {
  return attestNativeShell(
    defineTool(
      {
        name: "run_shell",
        guidance:
          "Use run_shell in the current project without targetWorktreeId or retryOf for an ordinary command. A managed worktree is not a prerequisite; use IDs only from successful corresponding tool results. Follow the advertised host shell syntax, not assumptions based on the OS name. A background task ID confirms launch only: inspect its status and result before claiming success. Check the actual exit code, signal, timeout and capture completeness. Never bypass a policy denial with another command or tool.",
        description: `Выполнить noninteractive команду с разрешением shell. background возвращает ID фоновой задачи; это не результат команды. Host execution не является OS sandbox. ${shellGuidance()}`,
        effect: "process",
        permission: "shell",
        parallelSafe: false,
      },
      ShellInputSchema,
      async (context, input) => {
        if (context.background)
          return context.background.prepareShell(context, input);
        if (input.background || input.targetWorktreeId)
          throw new RuntimeError(
            "BACKGROUND_UNAVAILABLE",
            "Сервис фоновых задач не подключён.",
          );
        const cwd = await context.workspace.resolve(input.cwd ?? ".");
        return {
          data: {
            ...input,
            cwd,
            actualRoot: context.workspace.root,
            timeout: input.timeout ?? 120000,
          } as ShellData,
          preview: `$ ${input.command}\nПапка: ${cwd}`,
          resources: [cwd],
          command: input.command,
        };
      },
      async (context, plan) => {
        if (context.backgroundExecution)
          return context.background!.executeShell(context, plan);
        if (context.background && context.promoteShellApproval)
          return context.background.foreground(
            context,
            plan,
            context.promoteShellApproval,
          );
        const result = await context.sandbox.execute({
          ...plan.data,
          signal: context.signal,
        });
        return {
          ...shellResult({
            outcome: result.outcome ?? {
              exitCode: result.exitCode,
              signal: null,
              cleanup: true,
              escaped: false,
            },
            output: result.output,
            command: plan.data.command,
            timeoutMs: plan.data.timeout,
            captureComplete: result.captureComplete ?? true,
          }),
          sandboxed: result.sandboxed,
        };
      },
    ),
  );
}
