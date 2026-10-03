import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { displayMcpCommand, parseMcpCommand } from "../mcp/command.js";
import { diagnoseMcp } from "../mcp/doctor.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { DEFAULT_MCP_PERMISSIONS, McpServerSchema } from "../mcp/schema.js";
import { McpConfigStore } from "../mcp/storage.js";
import { mcpTrustPreview } from "../mcp/trust-preview.js";

export function registerMcpCommands(program: Command): void {
  const root = program
    .command("mcp")
    .description("Подключения, инструменты и диагностика MCP");
  const json = () =>
    process.argv.includes("--json") || Boolean(program.optsWithGlobals().json);
  const output = (value: unknown, text: string) =>
    process.stdout.write(json() ? `${JSON.stringify(value)}\n` : `${text}\n`);
  const withManager = async (
    action: (manager: McpConnectionManager) => Promise<void>,
  ) => {
    const manager = new McpConnectionManager(
      new McpConfigStore(
        resolve(String(program.optsWithGlobals().cwd ?? process.cwd())),
      ),
    );
    try {
      await manager.reload();
      await action(manager);
    } catch (error) {
      const message = manager.redactor.text(
        error instanceof Error ? error.message : String(error),
      );
      output({ error: message }, message);
      process.exitCode = 1;
    } finally {
      await manager.dispose();
    }
  };
  const list = () =>
    withManager(async (manager) => {
      const servers = manager.list();
      output(
        { servers },
        servers.length
          ? servers
              .map(
                (server) =>
                  `${server.id}\t${server.scope}\t${server.transport}\t${server.configurationError ? "invalid_config" : !server.trusted ? "trust_required" : server.state}`,
              )
              .join("\n")
          : "MCP ещё не настроен. Откройте /mcp или выполните chisel mcp add --help.",
      );
    });
  root.action(list);
  root
    .command("list")
    .description("Список без запуска локальных команд")
    .action(list);
  root
    .command("add")
    .argument("<server>")
    .option("--url <url>", "адрес удалённого MCP")
    .option("--command <command>", "одна локальная команда в кавычках")
    .option("--config <path>", "файл строгой конфигурации сервера без секретов")
    .option("--project", "сохранить в .chiselrc (потребует доверия)")
    .option("--env-ref <pairs...>", "NAME=ENV_NAME")
    .option("--secret-ref <pairs...>", "NAME=credential-reference")
    .option("--token-ref <reference>", "ссылка на сохранённый bearer token")
    .option(
      "--test",
      "проверить подключение после сохранения (глобальная конфигурация)",
    )
    .action((id, raw) =>
      withManager(async (manager) => {
        if ([raw.url, raw.command, raw.config].filter(Boolean).length !== 1)
          throw new Error("Выберите --url, --command или --config.");
        if (manager.list().some((server) => server.id === id))
          throw new Error(
            "Такой MCP ID уже существует; удалите его перед заменой.",
          );
        const config = raw.config
          ? await (async () => {
              const input = await readFile(raw.config, "utf8");
              try {
                return JSON.parse(input);
              } catch {
                throw new Error("Невалидный JSON-файл конфигурации MCP.");
              }
            })()
          : {
              transport: raw.url
                ? { type: "http", url: raw.url }
                : { type: "stdio", ...parseMcpCommand(raw.command) },
              permissions: DEFAULT_MCP_PERMISSIONS,
            };
        const env = { ...config.env };
        for (const [flag, key] of [
          [raw.envRef ?? [], "envRef"],
          [raw.secretRef ?? [], "secretRef"],
        ] as const)
          for (const pair of flag) {
            const index = pair.indexOf("=");
            if (index < 1) throw new Error("Ожидается NAME=reference.");
            env[pair.slice(0, index)] = { [key]: pair.slice(index + 1) };
          }
        if (Object.keys(env).length) config.env = env;
        if (raw.tokenRef) config.auth = { token: { secretRef: raw.tokenRef } };
        const server = McpServerSchema.parse(config);
        await manager.store.save(
          id,
          server,
          raw.project ? "project" : "global",
        );
        await manager.reload();
        if (raw.test) await manager.connect(id);
        output(
          { server: manager.status(id) },
          `MCP ${id} сохранён${raw.project ? "; доверие: chisel mcp info / trust" : "."}`,
        );
      }),
    );
  root
    .command("remove")
    .argument("<server>")
    .action((id) =>
      withManager(async (manager) => {
        await manager.remove(id);
        output({ removed: id }, `MCP ${id} удалён.`);
      }),
    );
  for (const [command, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const)
    root
      .command(command)
      .argument("<server>")
      .action((id) =>
        withManager(async (manager) => {
          await manager.setEnabled(id, enabled);
          output(
            { server: manager.status(id) },
            `MCP ${id}: ${enabled ? "включён" : "отключён"}.`,
          );
        }),
      );
  root
    .command("info")
    .argument("<server>")
    .action((id) =>
      withManager(async (manager) => {
        const invalid = manager.status(id);
        if (invalid?.configurationError) {
          output(
            { server: invalid },
            `${invalid.label}\n${invalid.configurationError}`,
          );
          process.exitCode = 2;
          return;
        }
        const entry = manager.entry(id);
        const transport = entry.config.transport;
        const target =
          transport.type === "stdio"
            ? displayMcpCommand(transport.command, transport.args)
            : transport.url;
        output(
          {
            server: manager.status(id),
            config: entry.config,
            fingerprint: entry.fingerprint,
          },
          `${entry.config.label ?? id}\n${entry.scope} · ${transport.type}\n${entry.scope === "project" ? mcpTrustPreview(entry) : target}\nДоверие: ${entry.trusted ? "выдано" : "требуется"}${entry.scope === "project" ? "" : `\nОтпечаток: ${entry.fingerprint}`}`,
        );
      }),
    );
  root
    .command("trust")
    .argument("<server>")
    .requiredOption(
      "--fingerprint <sha256>",
      "проверенный отпечаток из mcp info",
    )
    .description(
      "Доверить точную конфигурацию проекта; запуск с правами пользователя",
    )
    .action((id, raw) =>
      withManager(async (manager) => {
        await manager.trust(id, raw.fingerprint, DEFAULT_MCP_PERMISSIONS);
        output(
          { trusted: id },
          `Конфигурация ${id} доверена; команда запустится при подключении.`,
        );
      }),
    );
  root
    .command("tools")
    .argument("<server>")
    .action((id) =>
      withManager(async (manager) => {
        await manager.connect(id);
        const tools = manager.tools(id).map(({ tool, classification }) => ({
          name: `${id}.${tool.name}`,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          ...classification,
        }));
        output(
          { tools },
          tools
            .map(
              (tool) =>
                `${tool.name}\t${tool.category}\t${tool.description ?? ""}`,
            )
            .join("\n"),
        );
      }),
    );
  root
    .command("doctor")
    .argument("[server]")
    .action((id) =>
      withManager(async (manager) => {
        const reports = await diagnoseMcp(manager, id);
        output(
          { servers: reports },
          reports
            .map(
              (report) =>
                `${report.label}\n${report.checks.map((check) => `  ${check.ok ? "+" : "x"} ${check.message}`).join("\n")}`,
            )
            .join("\n"),
        );
        process.exitCode = reports.every((report) => report.ok) ? 0 : 2;
      }),
    );
  root
    .command("logs")
    .argument("<server>")
    .description(
      "Подключить и показать безопасную диагностику текущего запуска",
    )
    .action((id) =>
      withManager(async (manager) => {
        if (!manager.status(id)) throw new Error("MCP-сервер не найден.");
        try {
          await manager.connect(id);
        } catch {}
        const logs = manager.logs(id);
        output(
          { logs },
          logs
            .map((log) => `${log.timestamp} ${log.level} ${log.message}`)
            .join("\n"),
        );
      }),
    );
}
