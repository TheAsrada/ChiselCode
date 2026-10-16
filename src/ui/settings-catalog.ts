export type SettingsRoute =
  | "connection"
  | "appearance"
  | "permissions"
  | "extensions"
  | "tools.background"
  | "tools.subagents"
  | "tools.lsp"
  | "tools.mcp"
  | "tools.web"
  | "tools.skills";

export interface SettingsDescriptor {
  id: SettingsRoute;
  group: string;
  title: string;
  description: string;
  keywords: readonly string[];
  fields: readonly { id: string; title: string; keywords: readonly string[] }[];
}

/** Metadata only: never add configuration values or secrets to this index. */
export const SETTINGS_SECTIONS: readonly SettingsDescriptor[] = [
  {
    id: "connection",
    group: "Модель и подключение",
    title: "Подключение",
    description: "Сервис, профиль, модель и доступ к API",
    keywords: ["connection", "provider", "подключение"],
    fields: [
      { id: "providers", title: "Сервис", keywords: ["provider", "service"] },
      { id: "profiles", title: "Профиль", keywords: ["profile", "account"] },
      { id: "model-list", title: "Модель", keywords: ["model", "llm"] },
      {
        id: "key",
        title: "API-ключ",
        keywords: ["ключ", "api", "key", "secret"],
      },
      {
        id: "base-url",
        title: "Адрес API",
        keywords: ["url", "endpoint", "base url"],
      },
    ],
  },
  {
    id: "appearance",
    group: "Внешний вид",
    title: "Тема",
    description: "Цветовая тема и предпросмотр",
    keywords: ["appearance", "theme", "тема", "цвет", "terminal", "графика"],
    fields: [
      {
        id: "theme",
        title: "Тема",
        keywords: ["theme", "paper", "dark", "light"],
      },
    ],
  },
  {
    id: "permissions",
    group: "Разрешения",
    title: "Доступ и Bypass",
    description: "Доступность режима Bypass; выбор режима остаётся отдельным",
    keywords: ["permissions", "approval", "bypass", "разрешения", "доступ"],
    fields: [],
  },
  {
    id: "extensions",
    group: "Расширения",
    title: "Расширения",
    description: "Встроенные возможности и установленные пакеты",
    keywords: [
      "extensions",
      "расширения",
      "пакеты",
      "установить",
      "доверие",
      "версии",
    ],
    fields: [],
  },
  {
    id: "tools.background",
    group: "Инструменты",
    title: "Фоновые задачи",
    description: "Локальные команды: время, вывод и хранение",
    keywords: ["background", "фон", "tasks", "процессы", "сервер", "watcher"],
    fields: [
      {
        id: "enabled",
        title: "Включение фоновых задач",
        keywords: ["выключить"],
      },
      {
        id: "limits",
        title: "Лимиты процессов и вывода",
        keywords: ["срок", "память", "хранение"],
      },
      { id: "project", title: "Настройки проекта", keywords: ["проект"] },
    ],
  },
  {
    id: "tools.subagents",
    group: "Инструменты",
    title: "Субагенты",
    description: "Помощники: чтение и работа в отдельных копиях",
    keywords: ["помощники", "делегирование", "subagent", "agents"],
    fields: [
      {
        id: "enabled",
        title: "Включение помощников",
        keywords: ["выключить", "enabled"],
      },
      {
        id: "maxActive",
        title: "Одновременно работающие помощники",
        keywords: ["лимит", "parallel"],
      },
      {
        id: "project",
        title: "Настройки проекта",
        keywords: ["проект", "project"],
      },
    ],
  },
  {
    id: "tools.lsp",
    group: "Инструменты",
    title: "Анализ кода (LSP)",
    description: "Ошибки, определения и ссылки · Auto для многих языков",
    keywords: [
      "lsp",
      "анализ кода",
      "языковой сервер",
      "typescript",
      "javascript",
      "diagnostics",
      "python",
      "go",
      "rust",
      "c++",
      "c#",
      "java",
      "kotlin",
      "php",
      "ruby",
      "swift",
      "lua",
      "dart",
      "clangd",
      "pyright",
      "сервер",
    ],
    fields: [
      {
        id: "mode",
        title: "Auto / Своя настройка / Выключено",
        keywords: ["auto", "авто", "режим", "выключить", "стандартный"],
      },
      {
        id: "project",
        title: "Настройки проекта",
        keywords: ["project", "проект", "наследовать", "tsconfig", "jsconfig"],
      },
      { id: "node", title: "Node.js", keywords: ["runtime", "node", "путь"] },
      {
        id: "server",
        title: "Language server",
        keywords: ["cli.mjs", "сервер"],
      },
      {
        id: "typescript",
        title: "TypeScript",
        keywords: ["tsserver", "typescript"],
      },
      {
        id: "trust",
        title: "Доверенные проекты",
        keywords: ["trust", "разрешить", "проект"],
      },
    ],
  },
  {
    id: "tools.mcp",
    group: "Инструменты",
    title: "MCP",
    description: "Подключённые MCP-серверы и их инструменты",
    keywords: ["mcp", "servers", "серверы"],
    fields: [],
  },
  {
    id: "tools.web",
    group: "Инструменты",
    title: "Web",
    description: "Поиск, чтение страниц и правила сетевого доступа",
    keywords: [
      "web",
      "search",
      "fetch",
      "поиск",
      "интернет",
      "exa",
      "parallel",
    ],
    fields: [],
  },
  {
    id: "tools.skills",
    group: "Инструменты",
    title: "Навыки",
    description: "Библиотека, инструкции и закрепление для беседы",
    keywords: ["skills", "скиллы", "навыки"],
    fields: [],
  },
];

export interface SettingsSearchResult {
  section: SettingsDescriptor;
  field?: string;
  title: string;
}
export function searchSettings(
  query: string,
  sections = SETTINGS_SECTIONS,
): SettingsSearchResult[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/[\s/]+/u)
    .filter(Boolean);
  const matches = (values: readonly string[]) => {
    const text = values.join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  };
  return sections.flatMap((section) => {
    if (terms.length) {
      const targets = section.fields.filter((field) =>
        matches([field.id, field.title, ...field.keywords]),
      );
      if (targets.length)
        return targets.map((field) => ({
          section,
          field: field.id,
          title: field.title,
        }));
    }
    if (
      !terms.length ||
      matches([
        section.id,
        section.title,
        section.description,
        ...section.keywords,
      ])
    )
      return [{ section, title: section.title }];
    return section.fields
      .filter((field) => matches([field.id, field.title, ...field.keywords]))
      .map((field) => ({ section, field: field.id, title: field.title }));
  });
}
