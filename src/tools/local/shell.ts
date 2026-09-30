import { z } from "zod";
import { defineTool } from "../handler.js";
export function shellHandler() {
  return defineTool(
    {
      name: "run_shell",
      description:
        "Execute a command in the project with permission. Host execution is not an OS sandbox.",
      effect: "process",
      permission: "shell",
      parallelSafe: false,
    },
    z.object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeout: z.number().int().min(1000).max(600000).optional(),
    }),
    async (context, input) => {
      const cwd = await context.workspace.resolve(input.cwd ?? ".");
      return {
        data: { ...input, cwd, timeout: input.timeout ?? 120000 },
        preview: `$ ${input.command}\nWorking directory: ${cwd}`,
        resources: [cwd],
        command: input.command,
      };
    },
    async (context, { data }) => {
      const result = await context.sandbox.execute({
        ...data,
        signal: context.signal,
      });
      const errors = result.output
        .split("\n")
        .filter((line) => /error|failed|\bFAIL\b|TS\d{4}|exception/i.test(line))
        .slice(0, 30)
        .join("\n")
        .slice(0, 6000);
      return {
        output:
          result.exitCode !== 0
            ? `Command failed (exit ${result.exitCode}).\n${errors || result.output.slice(-4000)}`
            : result.output,
        rawOutput: result.output,
        isError: result.exitCode !== 0,
        errorCode: result.exitCode !== 0 ? "TOOL_EXECUTION_FAILURE" : undefined,
        details: { exitCode: result.exitCode },
        sandboxed: result.sandboxed,
      };
    },
  );
}
