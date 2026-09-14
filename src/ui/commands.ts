export const SLASH_COMMANDS = [
  { name: "/help", description: "показать справку по командам" },
  { name: "/clear", description: "очистить экран" },
  { name: "/cwd", description: "сменить папку проекта: /cwd <путь>" },
  { name: "/settings", description: "открыть настройки" },
  { name: "/model", description: "сменить модель" },
  { name: "/status", description: "показать состояние сессии" },
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

export function commandHelpText(): string {
  return [
    "◈ ChiselCode — быстрые команды",
    "  /help — показать справку по командам",
    "  /clear — очистить экран",
    "  /cwd <путь> — сменить папку проекта (можно путь к файлу)",
    "  /settings — открыть настройки сервиса и модели",
    "  /model — быстро сменить модель для текущего сеанса",
    "  /status — показать состояние сессии",
    "  /update — проверить и установить обновление ChiselCode",
    "  /doctor — проверить настройку без показа ключей",
    "  /exit — закрыть ChiselCode",
    "",
    "Обычный текст отправляется помощнику. Shift+Enter — новая строка. PgUp/PgDn листают журнал, Home/End — его начало и конец.",
    "При запросе изменения нажмите y (разрешить) или n / Esc (отклонить).",
  ].join("\n");
}
