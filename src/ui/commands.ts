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

const HELP_GROUPS: { title: string; commands: string[] }[] = [
  { title: "Режим", commands: ["/plan", "/build", "/mode"] },
  { title: "Разрешения", commands: ["/permissions", "/ask", "/auto"] },
  {
    title: "Сессия",
    commands: ["/home", "/new", "/clear", "/sessions", "/resume"],
  },
  { title: "Проект", commands: ["/cwd", "/status", "/doctor"] },
  {
    title: "Приложение",
    commands: [
      "/settings",
      "/model",
      "/skills",
      "/mcp",
      "/update",
      "/sidebar",
      "/help",
      "/exit",
    ],
  },
];

export function commandHelpText(
  available: CommandProjection | readonly CommandSuggestion[] = [],
): string {
  const commands = projection(available).commands;
  const byName = new Map(
    commands.map((command) => [command.name, command.description]),
  );
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = ["[i] ChiselCode - быстрые команды"];
  for (const group of HELP_GROUPS) {
    lines.push("", `-- ${group.title} --`);
    for (const name of group.commands)
      lines.push(`  ${name.padEnd(width, " ")} - ${byName.get(name) ?? ""}`);
  }
  const skills = commands.filter((command) => command.source.type === "skill");
  if (skills.length) {
    lines.push("", "-- Скиллы --");
    for (const command of skills)
      lines.push(
        `  ${command.name.padEnd(width, " ")} - ${command.description}`,
      );
    lines.push(
      "Пользовательские скиллы: ChiselCode Home/skills/user/<имя>/SKILL.md.",
    );
  }
  const extensions = commands.filter(
    (command) => command.source.type === "extension",
  );
  if (extensions.length) {
    lines.push("", "-- Расширения --");
    for (const command of extensions) {
      if (command.source.type !== "extension") continue;
      lines.push(
        `  ${command.name.padEnd(width, " ")} - ${command.description} [${command.source.extensionId}]${command.usage ? ` | ${command.usage}` : ""}`,
      );
    }
  }
  lines.push(
    "",
    "Обычный текст отправляется помощнику. Shift+Enter - новая строка.",
    "Shift+Tab - Plan / Build для следующего запроса; модель сохраняется.",
    "Plan читает проект и составляет план; Build выполняет работу с обычными разрешениями.",
    "F4 - следующий режим разрешений; нажатие на метку или /permissions открывает меню.",
    "Manual спрашивает; Accept edits разрешает правки; Dont ask отклоняет всё без выданного разрешения.",
    "Bypass доступен только после включения в Settings / Разрешения и выбирается отдельно.",
    "Чтение и явно разрешённые правилами действия выполняются сразу; запреты и Plan сохраняются.",
    "Alt+N / Ctrl+Shift+N - новая вкладка; Alt+Left/Right / Ctrl+Tab - переключить.",
    "Ctrl+G - главная; Ctrl+W - закрыть вкладку без удаления сохранённой сессии.",
    "Ctrl+C - остановить запрос и очередь текущей вкладки; /exit - закрыть приложение.",
    "Вкладки работают параллельно; последующие запросы одной вкладки идут по очереди.",
    "Во время подтверждения можно переключить вкладку через Ctrl+Tab или Alt+Left/Right.",
    "Лента листается клавишами PgUp/PgDn (пол-экрана),",
    "колесом мыши (скорость CHISEL_SCROLL_SPEED 1..20, дефолт 3; Shift+колесо - рывок),",
    "Home - верх, End - возврат к вводу. Скролл вверх держит вид на месте,",
    "Ввод закреплён снизу; дальше последнего сообщения прокрутки нет.",
    "В классическом режиме (CHISEL_ALT_SCREEN=0) листает сам терминал,",
    "колесо и выделение текста - нативные.",
    "С захваченной мышью нативное выделение - через Shift.",
    "Windows: правая кнопка - вставить. Shift+выделение - копировать средствами терминала.",
    "Диффы: карточки файлов с номерами строк; щелчок раскрывает файл, Ctrl+D — последний дифф.",
    "При запросе изменения нажмите y (разрешить) или n / Esc (отклонить).",
  );
  return lines.join("\n");
}
