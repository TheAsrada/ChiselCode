import { z } from "zod";
import { RuntimeError } from "../../runtime/errors.js";
import {
  SCRATCH_LIMITS,
  ScratchWorkspace,
  scheduleScratchSweep,
  validScratchName,
} from "../../scratch/workspace.js";
import { defineTool } from "../handler.js";

const name = z
  .string()
  .refine(validScratchName)
  .describe(
    "Одно имя длиной до 80 символов: строчные латинские буквы, цифры, точка, подчёркивание и дефис. Пример: check.py.",
  );
const schema = z.strictObject({
  action: z.enum(["write", "read", "list", "remove", "clear"]),
  name: name.optional(),
  content: z
    .string()
    .max(SCRATCH_LIMITS.fileBytes)
    .optional()
    .describe("Текст файла для write."),
});

export function scratchHandler() {
  return defineTool(
    {
      name: "scratch_workspace",
      guidance:
        "Use scratch_workspace to store temporary scripts and data outside the project. Write a named file, then use run_shell with scratch: true and the file's relative name. Reuse files by name across turns. Use list or read to inspect them and clear or remove when done. Use the project tools for intended project changes.",
      description:
        "Управление временными файлами текущего проекта и сессии: write создаёт или заменяет текстовый файл, read читает, list перечисляет, remove удаляет файл, clear очищает каталог.",
      effect: "workspace_write",
      permission: "write",
      parallelSafe: false,
    },
    schema,
    async (context, input) => {
      const named =
        input.action === "write" ||
        input.action === "read" ||
        input.action === "remove";
      if (
        named !== (input.name !== undefined) ||
        (input.action === "write") !== (input.content !== undefined)
      )
        throw new RuntimeError(
          "INVALID_TOOL_INPUT",
          "Для write укажите name и content, для read/remove только name, для list/clear только action.",
        );
      const workspace = await ScratchWorkspace.forSession(
        context.workspace.root,
        context.session.id,
      );
      const file = "name" in input ? `\nФайл: ${input.name}` : "";
      return {
        data: {
          workspace,
          action: input.action,
          name: input.name ?? "",
          content: input.content ?? "",
        },
        preview: `Scratch Workspace: ${input.action}${file}`,
        resources: [workspace.path],
      };
    },
    async (context, { data: { workspace, action, name, content } }) => {
      scheduleScratchSweep();
      const run = async () => {
        switch (action) {
          case "write": {
            const bytes = await workspace.write(name, content, context.signal);
            return {
              output: `Сохранён scratch-файл ${name} (${bytes} байт).`,
              details: { name, bytes },
            };
          }
          case "read": {
            const text = await workspace.read(name, context.signal);
            if (text === undefined)
              throw new RuntimeError(
                "SCRATCH_FILE_MISSING",
                `Scratch-файл ${name} отсутствует.`,
              );
            return { output: text, details: { name } };
          }
          case "list": {
            const files = await workspace.list(context.signal);
            return {
              output: files.length
                ? JSON.stringify(files)
                : "Scratch Workspace пуст.",
              details: { files },
            };
          }
          case "remove": {
            const removed = await workspace.remove(name, context.signal);
            return {
              output: removed
                ? `Удалён scratch-файл ${name}.`
                : `Scratch-файл ${name} уже отсутствует.`,
            };
          }
          case "clear":
            await workspace.clear(context.signal);
            return { output: "Scratch Workspace очищен." };
        }
      };
      return context.background
        ? run()
        : workspace.withLease(context.signal, run);
    },
  );
}
