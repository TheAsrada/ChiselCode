import {
  type CommandProjection,
  type CommandSuggestion,
  composeCommandProjection,
  splitSlashCommand,
} from "../commands/slash.js";

export {
  type CommandSuggestion,
  type ParsedSlashCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommandName,
} from "../commands/slash.js";

function projection(
  value: CommandProjection | readonly CommandSuggestion[],
): CommandProjection {
  return "commands" in value ? value : composeCommandProjection(value);
}

/** Сколько подсказок показываем под вводом: остальные - счётчиком '...и ещё N'. */
export const MAX_VISIBLE_SUGGESTIONS = 6;

export function isSlashInput(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function matchingCommands(
  input: string,
  available: CommandProjection | readonly CommandSuggestion[] = [],
): readonly import("../commands/slash.js").CommandDescriptor[] {
  const query = input.trim().toLowerCase();
  return projection(available).commands.filter((command) =>
    command.name.startsWith(query),
  );
}

/**
 * 'Возможно, вы имели в виду': ближайшая команда к опечатке.
 * Возвращает имя со слэшем или undefined, если ничего похожего нет.
 */
export function suggestSimilarCommand(
  input: string,
  available: CommandProjection | readonly CommandSuggestion[] = [],
): string | undefined {
  const query = (splitSlashCommand(input)?.name ?? input.trim())
    .toLowerCase()
    .replace(/^\//, "");
  if (!query) return undefined;
  const candidates = projection(available).commands.map((command) =>
    command.name.slice(1),
  );
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
  // Допуск - две правки (транспозиция соседних букв считается за две):
  // опечатки вроде /hlep и /sessons ловятся, чушь - нет.
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
