import { isAbsolute } from "node:path";
import { McpServerSchema, type McpValue } from "../mcp/schema.js";
import type { MigrationSource } from "./contracts.js";
import { record, string } from "./files.js";
import type { ForeignMcp } from "./sources.js";

export function convertMcp(
  { name, config }: ForeignMcp,
  source: MigrationSource,
  id: string,
) {
  const data = record(config);
  const secrets: [string, string][] = [];
  function values(raw: unknown, group: string) {
    const result: Record<string, McpValue> = Object.create(null);
    for (const [key, item] of Object.entries(record(raw))) {
      if (typeof item !== "string")
        throw new Error("Неизвестное значение MCP.");
      const reference =
        /^(?:\$\{([A-Za-z_]\w*)\}|\{env:([A-Za-z_]\w*)\})$/.exec(item);
      const envRef = reference?.[1] ?? reference?.[2];
      if (envRef) result[key] = { envRef };
      else {
        if (/\$\{|\{(?:env|file):/.test(item))
          throw new Error("Составная ссылка MCP.");
        const secretRef = `migration:mcp:${id}:${group}:${key}`;
        secrets.push([secretRef, item]);
        result[key] = { secretRef };
      }
    }
    return result;
  }

  const type = string(data.type);
  if (type && !["stdio", "http", "remote", "local"].includes(type))
    return undefined;
  const url = string(data.url);
  const command =
    source === "opencode" && Array.isArray(data.command)
      ? data.command[0]
      : data.command;
  const args =
    source === "opencode" && Array.isArray(data.command)
      ? data.command.slice(1)
      : data.args;
  const cwd = string(data.cwd);
  const environment = source === "opencode" ? data.environment : data.env;
  const env = Object.assign(Object.create(null), values(environment, "env"));
  if (source === "codex" && Array.isArray(data.env_vars)) {
    for (const key of data.env_vars) {
      if (typeof key !== "string") return;
      env[key] ??= { envRef: key };
    }
  }
  const headers = values(data.headers ?? data.http_headers, "header");
  if (source === "codex") {
    for (const [key, value] of Object.entries(record(data.env_http_headers))) {
      if (typeof value !== "string") return;
      headers[key] = { envRef: value };
    }
  }
  const token = string(data.bearer_token_env_var);
  const parsed = McpServerSchema.safeParse({
    label: name.replace(/\p{C}/gu, "").slice(0, 80) || id,
    enabled: false,
    transport: url
      ? { type: "http", url, headers }
      : {
          type: "stdio",
          command,
          args,
          cwd: cwd && isAbsolute(cwd) ? cwd : undefined,
        },
    env: url ? {} : env,
    auth: url && token ? { token: { envRef: token } } : undefined,
  });
  return parsed.success ? { server: parsed.data, secrets } : undefined;
}
