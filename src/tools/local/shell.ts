import { attestNativeShell } from "../../background/capability.js";
import { type ShellData, ShellInputSchema } from "../../background/input.js";
import { shellFailureHint, shellGuidance } from "../../processes/shell.js";
import { RuntimeError } from "../../runtime/errors.js";
import { defineTool } from "../handler.js";
export function shellHandler() {
  return attestNativeShell(
    defineTool(
      {
        name: "run_shell",
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
        const hint =
          result.exitCode !== 0
            ? shellFailureHint(plan.data.command, result.output)
            : undefined;
        return {
          // Keep traceback context; the shared result store bounds large output.
          output: `${result.output}${hint ? `\n${hint}` : ""}`,
          rawOutput: result.output,
          isError: result.exitCode !== 0,
          errorCode:
            result.exitCode !== 0 ? "TOOL_EXECUTION_FAILURE" : undefined,
          details: { exitCode: result.exitCode },
          sandboxed: result.sandboxed,
        };
      },
    ),
  );
}
