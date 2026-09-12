export const SLASH_COMMANDS = [
  { name: "/help", description: "показать справку по командам" },
  { name: "/clear", description: "очистить экран" },
  { name: "/settings", description: "открыть настройки" },
  { name: "/model", description: "сменить модель" },
  { name: "/status", description: "показать состояние сессии" },
  { name: "/exit", description: "закрыть ChiselCode" },
] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"];

export interface ParsedSlashCommand {
  name: SlashCommandName;
}

export function parseSlashCommand(
  input: string,
): ParsedSlashCommand | undefined {
  const value = input.trim();
  return SLASH_COMMANDS.some((command) => command.name === value)
    ? { name: value as SlashCommandName }
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
