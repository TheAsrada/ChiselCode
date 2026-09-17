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

export interface CommandSuggestion {
  name: string;
  description: string;
}

/** Сколько подсказок показываем под вводом: остальные — счётчиком «…и ещё N». */
export const MAX_VISIBLE_SUGGESTIONS = 6;

export function isSlashInput(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function matchingCommands(
  input: string,
  custom: CommandSuggestion[] = [],
): CommandSuggestion[] {
  const query = input.trim().toLowerCase();
  const builtIn = SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(query),
  );
  if (!query.startsWith("/")) return [...builtIn];
  const seen = new Set<string>(builtIn.map((command) => command.name));
  const extra = custom
    .filter((command) => `/${command.name}`.startsWith(query))
    .filter((command) => !seen.has(`/${command.name}`))
    .map((command) => ({
      name: `/${command.name}`,
      description: command.description,
    }));
  return [...builtIn, ...extra];
}

/**
 * «Возможно, вы имели в виду»: ближайшая команда к опечатке.
 * Возвращает имя со слэшем или undefined, если ничего похожего нет.
 */
export function suggestSimilarCommand(
  input: string,
  custom: CommandSuggestion[] = [],
): string | undefined {
  const query = input.trim().toLowerCase().replace(/^\//, "");
  if (!query) return undefined;
  const candidates = [
    ...SLASH_COMMANDS.map((command) => command.name.slice(1)),
    ...custom.map((command) => command.name.replace(/^\//, "")),
  ];
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === query) return `/${candidate}`;
    const score = levenshtein(query, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  // Допуск — две правки (транспозиция соседних букв считается за две):
  // опечатки вроде /hlep и /sessons ловятся, чушь — нет.
  return bestScore <= 2 ? `/${best}` : undefined;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let corner = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = (row[j] ?? 0) + 1;
      const left = (row[j - 1] ?? 0) + 1;
      const diag = corner + (a[i - 1] === b[j - 1] ? 0 : 1);
      corner = row[j] ?? 0;
      row[j] = Math.min(above, left, diag);
    }
  }
  return row[b.length] ?? 0;
}

const HELP_GROUPS: { title: string; commands: string[] }[] = [
  { title: "Сессия", commands: ["/new", "/sessions", "/resume", "/clear"] },
  { title: "Проект", commands: ["/cwd", "/status", "/doctor"] },
  {
    title: "Приложение",
    commands: ["/settings", "/model", "/update", "/help", "/exit"],
  },
];

export function commandHelpText(custom: CommandSuggestion[] = []): string {
  const byName = new Map<string, string>(
    SLASH_COMMANDS.map((c) => [c.name, c.description]),
  );
  const extra = custom.filter((command) => !byName.has(`/${command.name}`));
  const width = Math.max(
    ...SLASH_COMMANDS.map((c) => c.name.length),
    ...extra.map((c) => c.name.length + 1),
  );
  const lines = ["◈ ChiselCode — быстрые команды"];
  for (const group of HELP_GROUPS) {
    lines.push("", `── ${group.title} ──`);
    for (const name of group.commands) {
      lines.push(`  ${name.padEnd(width, " ")} — ${byName.get(name) ?? ""}`);
    }
  }
  if (extra.length > 0) {
    lines.push("", "── Свои команды ──");
    for (const command of extra) {
      lines.push(
        `  ${`/${command.name}`.padEnd(width, " ")} — ${command.description}`,
      );
    }
    lines.push(
      "Файлы `.chisel/commands/*.md` в проекте (или рядом с конфигом).",
    );
  }
  lines.push(
    "",
    "Обычный текст отправляется помощнику. Shift+Enter — новая строка.",
    "PgUp/PgDn листают журнал, Home/End — его начало и конец, Esc — назад к вводу.",
    "При запросе изменения нажмите y (разрешить) или n / Esc (отклонить).",
  );
  return lines.join("\n");
}
