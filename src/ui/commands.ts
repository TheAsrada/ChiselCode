export const SLASH_COMMANDS = [
  { name: "/help", description: "показать справку по командам" },
  { name: "/clear", description: "очистить экран" },
  { name: "/cwd", description: "сменить папку проекта: <путь>" },
  { name: "/settings", description: "открыть настройки" },
  { name: "/model", description: "сменить модель" },
  { name: "/status", description: "показать состояние сессии" },
  { name: "/new", description: "начать новый сеанс" },
  { name: "/sessions", description: "список сеансов проекта" },
  { name: "/resume", description: "вернуться к сеансу: <номер>" },
  { name: "/update", description: "проверить и установить обновление" },
  { name: "/doctor", description: "проверить настройку без показа ключей" },
  { name: "/exit", description: "закрыть ChiselCode" },
] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"];

export interface ParsedSlashCommand {
  name: SlashCommandName;
  args: string;
}

export function parseSlashCommand(
  input: string,
): ParsedSlashCommand | undefined {
  const value = input.trim();
  const space = value.search(/\s/);
  const head = space === -1 ? value : value.slice(0, space);
  const args = space === -1 ? "" : value.slice(space).trim();
  return SLASH_COMMANDS.some((command) => command.name === head)
    ? { name: head as SlashCommandName, args }
    : undefined;
}

export function isSlashInput(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function matchingCommands(input: string) {
  const query = input.trim().toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

const HELP_GROUPS: { title: string; commands: string[] }[] = [
  { title: "Сессия", commands: ["/new", "/sessions", "/resume", "/clear"] },
  { title: "Проект", commands: ["/cwd", "/status", "/doctor"] },
  {
    title: "Приложение",
    commands: ["/settings", "/model", "/update", "/help", "/exit"],
  },
];

export function commandHelpText(): string {
  const byName = new Map<string, string>(
    SLASH_COMMANDS.map((c) => [c.name, c.description]),
  );
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
  const lines = ["◈ ChiselCode — быстрые команды"];
  for (const group of HELP_GROUPS) {
    lines.push("", `── ${group.title} ──`);
    for (const name of group.commands) {
      lines.push(`  ${name.padEnd(width, " ")} — ${byName.get(name) ?? ""}`);
    }
  }
  lines.push(
    "",
    "Обычный текст отправляется помощнику. Shift+Enter — новая строка.",
    "PgUp/PgDn листают журнал, Home/End — его начало и конец, Esc — назад к вводу.",
    "При запросе изменения нажмите y (разрешить) или n / Esc (отклонить).",
  );
  return lines.join("\n");
}
