import { z } from "zod";
import {
  type McpConfig,
  McpServerIdSchema,
  McpServerSchema,
} from "./schema.js";

export interface McpConfigDiagnostic {
  id: string;
  message: string;
  scope?: "global" | "project";
}
/** Invalid MCP data is disabled and diagnosed, without taking local tools down. */
export function readMcpConfig(raw: unknown): {
  config?: McpConfig;
  diagnostics: McpConfigDiagnostic[];
} {
  if (raw === undefined) return { diagnostics: [] };
  const envelope = z
    .strictObject({
      schemaVersion: z.literal(1),
      servers: z
        .record(z.string(), z.unknown())
        .refine((servers) => Object.keys(servers).length <= 64),
    })
    .safeParse(raw);
  if (!envelope.success)
    return {
      config: { schemaVersion: 1, servers: {} },
      diagnostics: [
        {
          id: "configuration",
          message:
            "Невалидная структура MCP. Ожидается schemaVersion: 1 и объект servers (до 64 серверов).",
        },
      ],
    };
  const config: McpConfig = { schemaVersion: 1, servers: {} };
  const diagnostics: McpConfigDiagnostic[] = [];
  for (const [id, value] of Object.entries(envelope.data.servers)) {
    if (!McpServerIdSchema.safeParse(id).success) {
      diagnostics.push({
        id: `invalid-${diagnostics.length + 1}`,
        message:
          "Недопустимый MCP ID. Используйте строчные латинские буквы, цифры, _ и -.",
      });
      continue;
    }
    const server = McpServerSchema.safeParse(value);
    if (server.success) config.servers[id] = server.data;
    else
      diagnostics.push({
        id,
        message: `Некорректные настройки MCP: ${[...new Set(server.error.issues.map((issue) => issue.path.join(".") || "server"))].join(", ")}. Секреты должны быть ссылками.`,
      });
  }
  return { config, diagnostics };
}
