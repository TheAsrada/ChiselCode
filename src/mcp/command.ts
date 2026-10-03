/** Parse argv, never a shell program. Windows paths retain their backslashes. */
export function parseMcpCommand(line: string): {
  command: string;
  args: string[];
} {
  const parts: string[] = [];
  let part = "",
    quote = "",
    present = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? "";
    if (!quote && /\s/.test(char)) {
      if (present) {
        parts.push(part);
        part = "";
        present = false;
      }
      continue;
    }
    if (char === quote && quote) {
      quote = "";
      present = true;
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      present = true;
      continue;
    }
    if (
      char === "\\" &&
      (line[i + 1] === quote || (!quote && /[\s"']/.test(line[i + 1] ?? "")))
    ) {
      part += line[++i];
      present = true;
      continue;
    }
    if (!quote && /[|;&<>`]/.test(char))
      throw new Error(
        "Укажите одну команду без shell-операторов. Аргументы запускаются напрямую.",
      );
    part += char;
    present = true;
  }
  if (quote) throw new Error("Закройте кавычки в команде.");
  if (present) parts.push(part);
  const command = parts.shift();
  if (!command) throw new Error("Введите исполняемую команду.");
  return { command, args: parts };
}
export function displayMcpCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) =>
      /^[a-zA-Z0-9_@./:\\=+-]+$/.test(part) ? part : JSON.stringify(part),
    )
    .join(" ");
}
