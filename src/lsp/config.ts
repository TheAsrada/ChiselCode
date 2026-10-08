import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { RuntimeError } from "../runtime/errors.js";
import {
  AUTO_SERVER_ID,
  autoLspLaunch,
  prepareAutoBackend,
} from "./backend.js";

export const LspServerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "Use an absolute path.");
export const LspServerSchema = z.strictObject({
  enabled: z.boolean(),
  backend: z.literal("typescript"),
  command: absolutePath,
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((arg) => !arg.includes("\0")),
    )
    .max(32),
  typescriptPath: absolutePath,
  trustedWorkspaces: z.array(absolutePath).max(128),
});
export const LspConfigSchema = z.strictObject({
  mode: z.enum(["auto", "custom", "off"]).optional(),
  servers: z
    .record(LspServerIdSchema, LspServerSchema)
    .refine(
      (servers) =>
        Object.keys(servers).length <= 32 &&
        !Object.hasOwn(servers, AUTO_SERVER_ID),
      "The auto server ID is reserved.",
    )
    .default({}),
});
export const ProjectLspConfigSchema = z.strictObject({
  mode: z.enum(["auto", "custom", "off"]).optional(),
  enabled: z.boolean().optional(),
  serverId: LspServerIdSchema.optional(),
});
export type LspConfig = z.infer<typeof LspConfigSchema>;
export type LspServerConfig = z.infer<typeof LspServerSchema>;
export type ProjectLspConfig = z.infer<typeof ProjectLspConfigSchema>;
export type LspMode = "auto" | "custom" | "off";
export function globalLspMode(config: LspConfig): LspMode {
  return (
    config.mode ?? (Object.keys(config.servers).length ? "custom" : "auto")
  );
}
export function effectiveLspMode(configuration: LspConfiguration): LspMode {
  const global = globalLspMode(configuration.global);
  if (global === "off" || configuration.project?.enabled === false)
    return "off";
  return (
    configuration.project?.mode ??
    (configuration.project?.serverId ? "custom" : global)
  );
}
export interface LspConfiguration {
  global: LspConfig;
  project?: ProjectLspConfig;
  ignorePatterns: string[];
}
export interface LspLaunch {
  id: string;
  kind?: "auto" | "custom";
  command: string;
  args: string[];
  typescriptPath: string;
  fingerprint: string;
  serverVersion: string;
  typescriptVersion: string;
}
export type LspAvailability =
  | "disabled"
  | "untrusted"
  | "unavailable"
  | "stopped";
export interface LspSelection {
  state: LspAvailability;
  kind?: "auto" | "custom";
  id?: string;
  config?: LspServerConfig;
  reason?: string;
}
export async function selectLspServer(
  root: string,
  configuration: LspConfiguration,
  requestedId?: string,
): Promise<LspSelection> {
  const mode = effectiveLspMode(configuration);
  if (mode === "off")
    return {
      state: "disabled",
      reason:
        globalLspMode(configuration.global) === "off"
          ? "Анализ кода выключен для всех проектов в Settings."
          : "Анализ кода выключен для этого проекта.",
    };
  if (mode === "auto")
    return requestedId && requestedId !== AUTO_SERVER_ID
      ? {
          state: "unavailable",
          id: requestedId,
          reason:
            "Выбран Auto. Для пользовательского сервера выберите «Своя настройка».",
        }
      : { state: "stopped", id: AUTO_SERVER_ID, kind: "auto" };
  if (requestedId === AUTO_SERVER_ID)
    return {
      state: "disabled",
      id: requestedId,
      reason: "Auto выключен; выбрана своя настройка.",
    };
  const servers = configuration.global.servers;
  const id = requestedId ?? configuration.project?.serverId;
  if (id) {
    const config = servers[id];
    if (!config)
      return {
        state: "unavailable",
        id,
        reason: "Выбранный сервер не настроен.",
      };
    if (!config.enabled)
      return { state: "disabled", id, config, reason: "Сервер выключен." };
    return (await trusted(root, config))
      ? { state: "stopped", id, kind: "custom", config }
      : {
          state: "untrusted",
          id,
          config,
          reason: "Разрешите запуск для этого проекта в Settings.",
        };
  }
  const enabled = Object.entries(servers)
    .filter(([, server]) => server.enabled)
    .sort(([a], [b]) => a.localeCompare(b));
  const allowed: typeof enabled = [];
  for (const entry of enabled)
    if (await trusted(root, entry[1])) allowed.push(entry);
  if (allowed.length > 1)
    return {
      state: "unavailable",
      reason:
        "Для проекта разрешено несколько серверов. Выберите ID в Settings.",
    };
  if (allowed[0])
    return {
      state: "stopped",
      id: allowed[0][0],
      kind: "custom",
      config: allowed[0][1],
    };
  if (!enabled.length && Object.keys(servers).length)
    return { state: "disabled", reason: "Пользовательские серверы выключены." };
  return enabled.length
    ? {
        state: "untrusted",
        reason: "Нет разрешения на запуск для этого проекта.",
      }
    : {
        state: "unavailable",
        reason:
          "Своя настройка не задана. Выберите Auto или добавьте сервер в Settings.",
      };
}
export async function resolveLspLaunch(
  root: string,
  selection: LspSelection,
  materialize = false,
  signal?: AbortSignal,
): Promise<LspLaunch> {
  if (selection.kind === "auto")
    return materialize ? prepareAutoBackend(root, signal) : autoLspLaunch(root);
  if (!selection.id || !selection.config)
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Language server is not configured.",
    );
  return validateLspLaunch(root, selection.id, selection.config);
}
async function trusted(
  root: string,
  config: LspServerConfig,
): Promise<boolean> {
  for (const candidate of config.trustedWorkspaces) {
    try {
      if ((await canonicalWorkspaceRoot(candidate)) === root) return true;
    } catch {
      /* Missing roots do not grant trust. */
    }
  }
  return false;
}
export function outsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
async function installedPackage(path: string, name: string): Promise<string> {
  const file = join(dirname(dirname(path)), "package.json");
  const info = await stat(file);
  if (!info.isFile() || info.size > 65536)
    throw new Error("Invalid package metadata.");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.name !== name || typeof value.version !== "string")
    throw new Error("Unexpected package metadata.");
  return value.version;
}
/** Filesystem validation only. Does not execute code or claim the Node version. */
export async function validateLspLaunch(
  root: string,
  id: string,
  config: LspServerConfig,
): Promise<LspLaunch> {
  LspServerSchema.parse(config);
  let component = "Node.js";
  const external = async (path: string) => {
    const canonical = await realpath(path);
    if (!outsideRoot(root, canonical))
      throw new RuntimeError(
        "PERMISSION_DENIED",
        "LSP runtime paths must be outside the analysed repository.",
      );
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error("Expected an installed file.");
    return canonical;
  };
  try {
    const command = await external(config.command);
    if (!/^node(?:\.exe)?$/i.test(basename(command)))
      throw new Error("Use a direct Node.js runtime.");
    if (
      !config.args[0] ||
      !isAbsolute(config.args[0]) ||
      !config.args.includes("--stdio")
    )
      throw new Error("Use an absolute cli.mjs and --stdio.");
    component = "Language server";
    const entry = await external(config.args[0]);
    if (basename(entry) !== "cli.mjs")
      throw new Error("Use the installed language server cli.mjs.");
    const extra = config.args.slice(1);
    if (
      extra[0] !== "--stdio" ||
      (extra.length !== 1 &&
        !(
          extra.length === 3 &&
          extra[1] === "--log-level" &&
          /^[1-4]$/.test(extra[2] ?? "")
        ))
    )
      throw new Error("Only --stdio and one --log-level 1..4 are supported.");
    component = "TypeScript";
    const tsInfo = await stat(config.typescriptPath);
    const typescriptPath = await external(
      tsInfo.isDirectory()
        ? join(config.typescriptPath, "tsserver.js")
        : config.typescriptPath,
    );
    if (basename(typescriptPath) !== "tsserver.js")
      throw new Error("Use TypeScript lib/tsserver.js or its lib directory.");
    component = "Language server";
    const serverVersion = await installedPackage(
      entry,
      "typescript-language-server",
    );
    component = "TypeScript";
    const typescriptVersion = await installedPackage(
      typescriptPath,
      "typescript",
    );
    if (serverVersion !== "6.0.1" || !/^6\./.test(typescriptVersion))
      throw new Error(
        "Supported: typescript-language-server 6.0.1 with TypeScript 6.x; Node >=22.22.2 is required.",
      );
    const args = [entry, ...extra];
    return {
      id,
      command,
      args,
      typescriptPath,
      serverVersion,
      typescriptVersion,
      fingerprint: JSON.stringify([id, command, args, typescriptPath]),
    };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      `Проверьте пути: ${component} не найден или несовместим. Нужны Node >=22.22.2, typescript-language-server 6.0.1 и TypeScript 6 вне проекта.`,
    );
  }
}
