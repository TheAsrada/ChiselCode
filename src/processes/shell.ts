export interface ShellRuntime {
  readonly kind: "cmd" | "posix";
  readonly executable: string;
}

/** Match the managed backend, rather than the terminal that launched ChiselCode. */
export function hostShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellRuntime {
  return Object.freeze(
    platform === "win32"
      ? {
          kind: "cmd" as const,
          executable: env.ComSpec ?? env.COMSPEC ?? env.comspec ?? "cmd.exe",
        }
      : { kind: "posix" as const, executable: "/bin/sh" },
  );
}

export function shellGuidance(shell: ShellRuntime = hostShell()): string {
  return shell.kind === "cmd"
    ? "run_shell выполняется в Windows CMD (cmd.exe), а не в PowerShell или Bash. Разделяй команды через & или &&; ; не является разделителем. Используй двойные кавычки для путей и аргументов, NUL для перенаправления. tail/head/grep/sed/cat не входят в стандартную Windows: для чтения используй read_file/search_files/list_directory, для ограниченного вывода — скрипт доступного runtime. PowerShell запускай явно через powershell.exe -NoLogo -NoProfile -NonInteractive -Command с корректными кавычками. Вывод ожидается в UTF-8. Не устанавливай Unix-утилиты ради обычного чтения; после ошибки проверь синтаксис и реальный exit code."
    : "run_shell выполняется в POSIX sh (/bin/sh), а не в интерактивном Bash/Zsh. Не используй Bash-only синтаксис без явного запуска Bash. Предпочитай read_file/search_files/list_directory для чтения файлов. Вывод ожидается в UTF-8; проверяй настоящий exit code, включая ошибки команд до последнего звена pipeline.";
}

/** Diagnose shell mismatches without rewriting or replaying approved commands. */
export function shellFailureHint(
  command: string,
  output: string,
  shell: ShellRuntime = hostShell(),
): string | undefined {
  if (shell.kind !== "cmd") return;
  let quoted = false;
  let literal = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === "^") {
      index++;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted) literal += character;
  }
  if (literal.includes(";"))
    return "run_shell использует CMD: символ ; не разделяет команды и попадает в аргументы. Используйте & или && либо явно запустите PowerShell.";
  if (
    /is not recognized|не является внутренней|не является внешней/i.test(output)
  )
    return "run_shell использует CMD. Проверьте наличие команды в PATH; Unix-утилиты tail/head/grep/sed/cat в стандартной Windows отсутствуют. Для чтения используйте файловые инструменты или доступный runtime.";
}
