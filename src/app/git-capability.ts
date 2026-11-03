import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ToolHandler } from "../tools/types.js";

/** Availability is a workspace fact, never an approval or a repository integrity check. */
export class GitCapability {
  private available: boolean | undefined;
  constructor(
    private readonly root: string,
    private readonly signal?: AbortSignal,
  ) {}

  async refresh(): Promise<void> {
    cancelled(this.signal);
    for (
      let directory = await realpath(this.root);
      ;
      directory = dirname(directory)
    ) {
      cancelled(this.signal);
      try {
        await lstat(join(directory, ".git"));
        this.available = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.available = undefined;
          return; // An inaccessible marker is not proof that a repository is absent.
        }
      }
      if (dirname(directory) === directory) {
        this.available = false;
        return;
      }
    }
  }

  reason(handler: ToolHandler): RuntimeError | undefined {
    if (this.available !== false) return;
    const source = handler.spec.source;
    const requiresGit =
      source?.type === "local"
        ? ["git_status", "git_diff", "git_commit"].includes(handler.spec.name)
        : source?.type === "extension" &&
          (source.extensionId === "builtin.worktrees" ||
            (source.extensionId === "builtin.subagents" &&
              source.originalName === "submit_coding"));
    if (requiresGit)
      return new RuntimeError(
        "GIT_NOT_REPOSITORY",
        "В текущем проекте нет Git-репозитория; Git и рабочие копии недоступны. Продолжайте обычную работу с файлами и shell без Git. Инструмент не выполнялся.",
      );
  }

  instructions(): string {
    return this.available === false
      ? "\n\n<workspace_capabilities>\nВ текущей папке и её родительских папках нет Git-репозитория. Локальные инструменты Git/worktree и coding-помощник с рабочей копией недоступны и не объявлены. Используйте обычные файловые инструменты и shell для задачи; не обходите отсутствие Git-инструментов командами git через shell. Создавайте Git-репозиторий только по явному поручению пользователя.\n</workspace_capabilities>"
      : "";
  }
}
