import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { McpConnectionManager } from "./manager.js";

export interface McpDoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}
export interface McpDoctorReport {
  id: string;
  label: string;
  ok: boolean;
  checks: McpDoctorCheck[];
}
async function executableExists(
  command: string,
  cwd: string,
): Promise<boolean> {
  const directories =
    isAbsolute(command) || /[\\/]/.test(command)
      ? [""]
      : (process.env.PATH ?? "").split(delimiter);
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  for (const directory of directories)
    for (const extension of extensions) {
      try {
        await access(
          resolve(cwd, directory, command + extension),
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return true;
      } catch {}
    }
  return false;
}
export async function diagnoseMcp(
  manager: McpConnectionManager,
  id?: string,
  signal?: AbortSignal,
): Promise<McpDoctorReport[]> {
  await manager.reload();
  const selected = manager.list().filter((server) => !id || server.id === id);
  if (id && !selected.length) throw new Error("MCP-сервер не найден.");
  return Promise.all(
    selected.map(async (server) => {
      if (server.configurationError)
        return {
          id: server.id,
          label: server.label,
          ok: false,
          checks: [
            {
              name: "configuration",
              ok: false,
              message: server.configurationError,
            },
          ],
        };
      const entry = manager.entry(server.id);
      const checks: McpDoctorCheck[] = [
        { name: "configuration", ok: true, message: "Конфигурация валидна" },
      ];
      if (!entry.config.enabled)
        return {
          id: server.id,
          label: server.label,
          ok: true,
          checks: [
            ...checks,
            { name: "disabled", ok: true, message: "Отключён пользователем" },
          ],
        };
      if (!entry.trusted)
        return {
          id: server.id,
          label: server.label,
          ok: false,
          checks: [
            ...checks,
            {
              name: "trust",
              ok: false,
              message:
                "Требуется доверие к конфигурации проекта; команда не запускалась",
            },
          ],
        };
      if (entry.config.transport.type === "stdio") {
        const found = await executableExists(
          entry.config.transport.command,
          resolve(entry.projectRoot, entry.config.transport.cwd ?? "."),
        );
        checks.push({
          name: "executable",
          ok: found,
          message: found
            ? "Исполняемая команда в PATH или по указанному пути"
            : `Команда не найдена: ${entry.config.transport.command}. Проверьте путь и PATH.`,
        });
      }
      try {
        await manager.connect(server.id, signal);
      } catch {}
      const status = manager.status(server.id);
      checks.push({
        name: "connection",
        ok: status?.state === "connected",
        message:
          status?.lastError?.message ??
          (status?.state === "connected"
            ? "Подключение и инициализация успешны"
            : "Сервер недоступен"),
      });
      if (status?.info)
        checks.push({
          name: "protocol",
          ok: true,
          message: `Протокол ${status.info.protocolVersion}`,
        });
      if (status?.state === "connected") {
        checks.push({
          name: "authentication",
          ok: true,
          message: entry.config.auth
            ? "Учётные данные приняты"
            : "Дополнительная авторизация не запрошена",
        });
        checks.push({
          name: "tools",
          ok: true,
          message: `${status.toolsCount} инструментов обнаружено`,
        });
        checks.push({
          name: "latency",
          ok: true,
          message: `Инициализация и обнаружение: ${status.latencyMs ?? 0} мс`,
        });
      }
      const stderr = manager
        .logs(server.id)
        .filter((log) => log.level === "warn")
        .slice(-3);
      if (status?.state !== "connected")
        for (const log of [
          ...new Map(stderr.map((log) => [log.message, log])).values(),
        ])
          checks.push({ name: "stderr", ok: false, message: log.message });
      return {
        id: server.id,
        label: server.label,
        ok: checks.every((check) => check.ok),
        checks,
      };
    }),
  );
}
