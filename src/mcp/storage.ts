import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  globalConfigPath,
  loadGlobalConfig,
  loadProjectConfig,
  saveGlobalConfig,
} from "../config/load.js";
import { RuntimeError } from "../runtime/errors.js";
import { canonicalInput } from "../tools/invocation.js";
import {
  type McpPermissions,
  McpPermissionsSchema,
  type McpServerConfig,
  McpServerIdSchema,
  McpServerSchema,
} from "./schema.js";

export interface McpServerEntry {
  id: string;
  scope: "global" | "project";
  projectRoot: string;
  config: McpServerConfig;
  fingerprint: string;
  trusted: boolean;
  permissions: McpPermissions;
}
const TrustSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.record(
    z.string(),
    z.strictObject({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      trusted: z.boolean(),
      permissions: McpPermissionsSchema,
    }),
  ),
});
type TrustData = z.infer<typeof TrustSchema>;
const writes = new Map<string, Promise<unknown>>();
export async function serializedMcpWrite<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  writes.set(path, current);
  try {
    return await current;
  } finally {
    if (writes.get(path) === current) writes.delete(path);
  }
}
export function mcpFingerprint(root: string, config: McpServerConfig): string {
  return createHash("sha256")
    .update(canonicalInput({ root: resolve(root), config }))
    .digest("hex");
}
export async function writeMcpJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export class McpConfigStore {
  diagnostics: import("./configuration.js").McpConfigDiagnostic[] = [];
  readonly globalPath: string;
  readonly trustPath: string;
  constructor(
    readonly projectRoot: string,
    options: { globalPath?: string; trustPath?: string } = {},
  ) {
    this.globalPath = options.globalPath ?? globalConfigPath();
    this.trustPath =
      options.trustPath ?? join(dirname(this.globalPath), "mcp-trust.json");
  }
  private key(id: string): string {
    return (
      createHash("sha256").update(resolve(this.projectRoot)).digest("hex") +
      ":" +
      id
    );
  }
  private async trustData(): Promise<TrustData> {
    try {
      return TrustSchema.parse(
        JSON.parse(await readFile(this.trustPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, entries: {} };
      throw new Error(
        "Хранилище доверия MCP повреждено; команды проекта не запущены.",
      );
    }
  }
  async load(): Promise<McpServerEntry[]> {
    let trustError = false;
    const [global, project, trust] = await Promise.all([
      loadGlobalConfig(this.globalPath),
      loadProjectConfig(this.projectRoot),
      this.trustData().catch(() => {
        trustError = true;
        return { schemaVersion: 1 as const, entries: {} } as TrustData;
      }),
    ]);
    this.diagnostics = [
      ...(global.mcpDiagnostics ?? []).map((diagnostic) => ({
        ...diagnostic,
        scope: "global" as const,
      })),
      ...(project.mcpDiagnostics ?? []).map((diagnostic) => ({
        ...diagnostic,
        scope: "project" as const,
      })),
    ];
    if (trustError)
      this.diagnostics.push({
        id: "project-trust",
        scope: "project",
        message:
          "Хранилище доверия MCP повреждено. Серверы проекта не запускаются; восстановите mcp-trust.json.",
      });
    const entries: McpServerEntry[] = [];
    for (const [scope, servers] of [
      ["global", global.mcp?.servers ?? {}],
      ["project", project.mcp?.servers ?? {}],
    ] as const) {
      for (const [id, config] of Object.entries(servers)) {
        // A cloned project cannot replace a user-owned server or its permissions.
        if (scope === "project" && global.mcp?.servers[id]) continue;
        const fingerprint = mcpFingerprint(this.projectRoot, config);
        const saved = trust.entries[this.key(id)];
        const matching = saved?.fingerprint === fingerprint;
        const permissions =
          scope === "global"
            ? config.permissions
            : matching
              ? saved.permissions
              : { categories: {}, tools: {} };
        // Project denies still win over any user allow. Repository allows never grant access.
        if (scope === "project") {
          for (const [tool, decision] of Object.entries(
            config.permissions.tools,
          ))
            if (decision === "deny") permissions.tools[tool] = "deny";
          for (const [category, decision] of Object.entries(
            config.permissions.categories,
          ))
            if (decision === "deny")
              permissions.categories[
                category as keyof typeof permissions.categories
              ] = "deny";
          if (config.permissions.default === "deny")
            permissions.default = "deny";
        }
        entries.push({
          id,
          scope,
          projectRoot: this.projectRoot,
          config,
          fingerprint,
          trusted: scope === "global" || (matching && saved.trusted),
          permissions,
        });
      }
    }
    return entries;
  }
  async save(
    id: string,
    config: unknown,
    scope: "global" | "project" = "global",
  ): Promise<void> {
    McpServerIdSchema.parse(id);
    const server = McpServerSchema.parse(config);
    const path =
      scope === "global"
        ? this.globalPath
        : join(this.projectRoot, ".chiselrc");
    await serializedMcpWrite(path, async () => {
      if (scope === "global") {
        const current = await loadGlobalConfig(path);
        await saveGlobalConfig(
          {
            ...current,
            mcp: {
              schemaVersion: 1,
              servers: { ...current.mcp?.servers, [id]: server },
            },
          },
          path,
        );
      } else {
        let current: Record<string, unknown> = {};
        try {
          current = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error("Невалидный .chiselrc; файл не изменён.");
        }
        const project = await loadProjectConfig(this.projectRoot);
        if (project.mcpDiagnostics?.length)
          throw new Error(
            "Сначала исправьте невалидную MCP-конфигурацию проекта; файл не изменён.",
          );
        await writeMcpJson(path, {
          ...current,
          mcp: {
            schemaVersion: 1,
            servers: { ...project.mcp?.servers, [id]: server },
          },
        });
      }
    });
  }
  async remove(entry: McpServerEntry): Promise<void> {
    const path =
      entry.scope === "global"
        ? this.globalPath
        : join(this.projectRoot, ".chiselrc");
    await serializedMcpWrite(path, async () => {
      if (entry.scope === "global") {
        const current = await loadGlobalConfig(path);
        const servers = { ...current.mcp?.servers };
        delete servers[entry.id];
        await saveGlobalConfig(
          { ...current, mcp: { schemaVersion: 1, servers } },
          path,
        );
      } else {
        const current = JSON.parse(await readFile(path, "utf8"));
        delete current.mcp.servers[entry.id];
        await writeMcpJson(path, current);
      }
    });
  }
  async trust(
    entry: McpServerEntry,
    permissions: McpPermissions,
  ): Promise<void> {
    if (entry.scope !== "project") return;
    const current = (await this.load()).find((item) => item.id === entry.id);
    if (!current || current.fingerprint !== entry.fingerprint)
      throw new Error("Конфигурация MCP изменилась. Проверьте команду заново.");
    await serializedMcpWrite(this.trustPath, async () => {
      const data = await this.trustData();
      data.entries[this.key(entry.id)] = {
        fingerprint: entry.fingerprint,
        trusted: true,
        permissions: McpPermissionsSchema.parse(permissions),
      };
      await writeMcpJson(this.trustPath, data);
    });
  }
  async setPermissions(
    entry: McpServerEntry,
    permissions: McpPermissions,
  ): Promise<void> {
    if (entry.scope === "global")
      await this.save(entry.id, { ...entry.config, permissions });
    else await this.trust(entry, permissions);
  }
  /** Narrow approval updates merge under the same lock as other settings writes. */
  async rememberTool(
    entry: McpServerEntry,
    tool: string,
    category: keyof McpPermissions["categories"],
  ): Promise<void> {
    const allow = (permissions: McpPermissions): McpPermissions => {
      if (
        permissions.default === "deny" ||
        permissions.categories[category] === "deny" ||
        permissions.tools[tool] === "deny"
      )
        throw new RuntimeError(
          "PERMISSION_DENIED",
          "Разрешение MCP отозвано; действие не выполнено.",
        );
      return {
        ...permissions,
        tools: { ...permissions.tools, [tool]: "allow" },
      };
    };
    if (entry.scope === "global")
      await serializedMcpWrite(this.globalPath, async () => {
        const global = await loadGlobalConfig(this.globalPath);
        const current = global.mcp?.servers[entry.id];
        if (!current) throw new Error("MCP-сервер удалён.");
        const { permissions: _old, ...original } = entry.config;
        const { permissions: _current, ...latest } = current;
        if (canonicalInput(original) !== canonicalInput(latest))
          throw new Error(
            "Конфигурация MCP изменилась. Подготовьте новый вызов.",
          );
        await saveGlobalConfig(
          {
            ...global,
            mcp: {
              schemaVersion: 1,
              servers: {
                ...global.mcp?.servers,
                [entry.id]: {
                  ...current,
                  permissions: allow(current.permissions),
                },
              },
            },
          },
          this.globalPath,
        );
      });
    else
      await serializedMcpWrite(this.trustPath, async () => {
        const current = (await this.load()).find(
          (candidate) => candidate.id === entry.id,
        );
        if (!current?.trusted || current.fingerprint !== entry.fingerprint)
          throw new Error("Доверие к MCP-конфигурации изменилось.");
        const data = await this.trustData();
        const saved = data.entries[this.key(entry.id)];
        if (!saved || saved.fingerprint !== entry.fingerprint || !saved.trusted)
          throw new Error("Доверие к MCP-конфигурации отозвано.");
        saved.permissions = allow(current.permissions);
        await writeMcpJson(this.trustPath, data);
      });
  }
}
