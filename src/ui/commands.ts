export const SLASH_COMMANDS = [
  { name: "/help", description: "показать справку по командам" },
  { name: "/clear", description: "очистить экран" },
  { name: "/cwd", description: "сменить папку проекта: /cwd <путь>" },
  { name: "/settings", description: "открыть настройки" },
  { name: "/model", description: "сменить модель" },
  { name: "/status", description: "показать состояние сессии" },
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

export function commandHelpText(): string {
  return [
    "Быстрые команды:",
    ...SLASH_COMMANDS.map(
      (command) => `  ${command.name} — ${command.description}`,
    ),
    "Обычный текст отправляется помощнику. Shift+Enter — новая строка.",
  ].join("\n");
}
