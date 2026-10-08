export type SettingsRoute =
  | "connection"
  | "appearance"
  | "permissions"
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
    group: "Оформление",
    title: "Тема и терминал",
    description: "Цветовая тема и совместимая графика",
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
    id: "tools.lsp",
    group: "Инструменты",
    title: "Анализ кода (LSP)",
    description: "Ошибки, определения и ссылки в TypeScript/JavaScript",
    keywords: [
      "lsp",
      "анализ кода",
      "языковой сервер",
      "typescript",
      "javascript",
      "diagnostics",
    ],
    fields: [
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
    title: "Скиллы",
    description: "Установленные инструкции и доступные скиллы",
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
