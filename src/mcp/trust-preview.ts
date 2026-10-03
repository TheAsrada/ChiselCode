import { resolve } from "node:path";
import { displayMcpCommand } from "./command.js";
import type { McpValue } from "./schema.js";
import type { McpServerEntry } from "./storage.js";

function reference(value: McpValue): string {
  if ("secretRef" in value) return `хранилище: ${value.secretRef}`;
  if ("envRef" in value) return `переменная: ${value.envRef}`;
  return `обычное значение: ${JSON.stringify(value.literal)}`;
}
/** Describe credential sources without resolving or displaying their values. */
export function mcpTrustPreview(entry: McpServerEntry): string {
  const { transport } = entry.config;
  const lines = [`Этот проект определяет MCP: ${entry.id}`, ""];
  if (transport.type === "stdio") {
    lines.push(
      "Будет выполнена команда:",
      displayMcpCommand(transport.command, transport.args),
      "",
      `Рабочая папка: ${resolve(entry.projectRoot, transport.cwd ?? ".")}`,
      "Окружение:",
      ...Object.entries(entry.config.env).map(
        ([name, value]) => `  ${name} <- ${reference(value)}`,
      ),
    );
    if (!Object.keys(entry.config.env).length)
      lines.push("  только базовые переменные");
    lines.push("Команда запускается с вашими правами.");
  } else {
    lines.push(
      "Будет установлено соединение:",
      transport.url,
      "",
      "HTTP headers:",
    );
    lines.push(
      ...Object.entries(transport.headers).map(
        ([name, value]) => `  ${name} <- ${reference(value)}`,
      ),
    );
    if (!Object.keys(transport.headers).length) lines.push("  не заданы");
    if (entry.config.auth)
      lines.push(`Токен доступа <- ${reference(entry.config.auth.token)}`);
    lines.push("Учётные данные передаются этому серверу.");
  }
  lines.push(
    "",
    `Отпечаток: ${entry.fingerprint}`,
    "Изменение конфигурации отменит доверие.",
  );
  return lines.join("\n");
}
