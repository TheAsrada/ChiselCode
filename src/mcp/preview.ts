import type { McpApprovalPreview } from "../security/approval.js";
import type { ToolSource } from "../tools/types.js";
import type { JsonObject } from "../types/domain.js";
import type { McpRedactor } from "./redaction.js";

const targetKeys = [
  "repository",
  "repo",
  "owner",
  "project",
  "database",
  "collection",
  "path",
  "url",
  "resource",
  "issue_number",
  "pull_number",
  "id",
  "title",
  "labels",
  "body",
  "content",
];
const fieldLabels: Record<string, string> = {
  repository: "Репозиторий",
  repo: "Репозиторий",
  owner: "Владелец",
  project: "Проект",
  database: "База данных",
  collection: "Коллекция",
  notebook: "Блокнот",
  path: "Путь",
  url: "Адрес",
  resource: "Ресурс",
  issue_number: "Номер задачи",
  pull_number: "Pull request",
  id: "ID",
  title: "Заголовок",
  labels: "Метки",
  body: "Текст",
  content: "Содержимое",
};
export function mcpApprovalPreview(
  source: Extract<ToolSource, { type: "mcp" }>,
  effect: string,
  input: JsonObject,
  redactor: McpRedactor,
): McpApprovalPreview {
  const keys = [
    ...new Set([
      ...targetKeys.filter((key) => Object.hasOwn(input, key)),
      ...Object.keys(input),
    ]),
  ].slice(0, 10);
  const fields = keys.map((key) => {
    const value = redactor.value(input[key]);
    const text =
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.map(String).join(", ")
          : JSON.stringify(value);
    return {
      label: fieldLabels[key] ?? key.replaceAll("_", " "),
      value: (text ?? "—").slice(
        0,
        key === "body" || key === "content" ? 800 : 300,
      ),
    };
  });
  const destructive = effect === "external_destructive";
  return {
    serverId: source.serverId,
    serverTitle: source.serverTitle,
    originalName: source.originalName,
    title: source.title ?? source.originalName.replaceAll("_", " "),
    category: source.category,
    fields,
    destructive,
    consequence: destructive
      ? "Может удалить данные или необратимо изменить внешний ресурс."
      : effect === "external_read"
        ? "Данные будут прочитаны с внешнего сервера."
        : effect === "process"
          ? "Сервер может выполнить код с правами своего процесса."
          : "Создаёт или изменяет данные вне проекта.",
  };
}
export function formatMcpPreview(preview: McpApprovalPreview): string {
  return [
    preview.serverTitle,
    preview.title,
    "",
    ...preview.fields.flatMap((field) => [field.label, `  ${field.value}`]),
    "",
    preview.consequence,
  ].join("\n");
}
