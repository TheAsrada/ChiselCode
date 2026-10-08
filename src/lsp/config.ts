import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { z } from "zod";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { RuntimeError } from "../runtime/errors.js";
import {
  AUTO_SERVER_ID,
  autoLspLaunch,
  prepareAutoBackend,
} from "./backend.js";
import {
  catalogLanguage,
  catalogServer,
  type LspServerDescriptor,
} from "./catalog.js";
import { catalogLspLaunch } from "./provision.js";

export const LspServerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "Use an absolute path.");
const serverFields = {
  enabled: z.boolean(),
  command: absolutePath,
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((arg) => !arg.includes("\0")),
    )
    .max(32),
  trustedWorkspaces: z.array(absolutePath).max(128),
};
const jsonSettings = z
  .record(z.string().max(128), z.json())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 65536,
    "LSP settings are limited to 64 KiB.",
  );
export const LspServerSchema = z.discriminatedUnion("backend", [
  z.strictObject({
    ...serverFields,
    backend: z.literal("typescript"),
    typescriptPath: absolutePath,
  }),
  z.strictObject({
    ...serverFields,
    backend: z.literal("generic"),
    languageIds: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.+-]{0,63}$/))
      .min(1)
      .max(32),
    extensions: z
      .array(z.string().regex(/^\.[a-zA-Z0-9_-]{1,32}$/))
      .max(64)
      .default([]),
    initializationOptions: jsonSettings.optional(),
    settings: jsonSettings.optional(),
  }),
]);
export function customLanguage(
  config: LspServerConfig,
  path: string,
): string | undefined {
  const detected = catalogLanguage(path)?.language.id;
  if (config.backend === "typescript")
    return detected &&
      [
        "typescript",
        "typescriptreact",
        "javascript",
        "javascriptreact",
      ].includes(detected)
      ? detected
      : undefined;
  if (detected && config.languageIds.includes(detected)) return detected;
  return config.extensions
    .map((extension) => extension.toLowerCase())
    .includes(extname(path).toLowerCase())
    ? config.languageIds[0]
    : undefined;
}
export function configuredLanguage(
  configuration: LspConfiguration,
  path: string,
): string | undefined {
  if (effectiveLspMode(configuration) !== "custom")
    return catalogLanguage(path)?.language.id;
  const selected = configuration.project?.serverId;
  if (selected)
    return (
      configuration.global.servers[selected] &&
      customLanguage(configuration.global.servers[selected], path)
    );
  return Object.values(configuration.global.servers)
    .filter((server) => server.enabled)
    .map((server) => customLanguage(server, path))
    .find(Boolean);
}
export const LspConfigSchema = z.strictObject({
  mode: z.enum(["auto", "custom", "off"]).optional(),
  servers: z
    .record(LspServerIdSchema, LspServerSchema)
    .refine(
      (servers) =>
        Object.keys(servers).length <= 32 &&
        !Object.keys(servers).some(
          (id) => id === AUTO_SERVER_ID || id.startsWith("auto-"),
        ),
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
  backend?: string;
  typescriptPath?: string;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  environment?: Record<string, string>;
  fingerprint: string;
  serverVersion: string;
  typescriptVersion?: string;
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
  descriptor?: LspServerDescriptor;
  reason?: string;
}
export async function selectLspServer(
  root: string,
  configuration: LspConfiguration,
  requestedId?: string,
  path?: string,
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
  if (mode === "auto") {
    const descriptor = requestedId
      ? catalogServer(requestedId)
      : path
        ? catalogLanguage(path)?.server
        : catalogServer(AUTO_SERVER_ID);
    return !descriptor
      ? {
          state: "unavailable",
          id: requestedId,
          reason: path
            ? "Для этого языка нет Auto backend. Подключите совместимый stdio LSP в своей настройке."
            : "Этот Auto backend неизвестен. Для пользовательского сервера выберите «Своя настройка».",
        }
      : { state: "stopped", id: descriptor.id, kind: "auto", descriptor };
  }
  if (requestedId === AUTO_SERVER_ID || requestedId?.startsWith("auto-"))
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
    if (path && !customLanguage(config, path))
      return {
        state: "unavailable",
        id,
        config,
        reason: "Этот сервер не настроен для языка файла.",
      };
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
    .filter(
      ([, server]) =>
        server.enabled && (!path || !!customLanguage(server, path)),
    )
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
  if (selection.kind === "auto") {
    if (selection.id === AUTO_SERVER_ID)
      return materialize
        ? prepareAutoBackend(root, signal)
        : autoLspLaunch(root);
    if (!selection.descriptor)
      throw new RuntimeError("LSP_UNAVAILABLE", "Unknown Auto backend.");
    return catalogLspLaunch(root, selection.descriptor, materialize, signal);
  }
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
    if (config.backend === "generic") {
      if (/\.(?:cmd|bat|ps1)$/i.test(command))
        throw new Error("Use a direct executable, not a shell wrapper.");
      const args = [...config.args];
      for (const argument of args)
        if (/\.(?:js|mjs|cjs|py|rb|jar|dll)$/i.test(argument)) {
          if (!isAbsolute(argument))
            throw new Error(
              "Executable script paths must be absolute and outside the repository.",
            );
          await external(argument);
        }
      return {
        id,
        kind: "custom",
        backend: "generic",
        command,
        args,
        serverVersion: "custom",
        initializationOptions: structuredClone(
          config.initializationOptions ?? {},
        ),
        settings: structuredClone(config.settings ?? {}),
        fingerprint: JSON.stringify([
          id,
          command,
          args,
          config.languageIds,
          config.extensions,
          config.initializationOptions,
          config.settings,
        ]),
      };
    }
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
      kind: "custom",
      backend: "typescript",
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
      config.backend === "generic"
        ? "Проверьте executable и script paths: нужен установленный совместимый stdio LSP вне проекта."
        : `Проверьте пути: ${component} не найден или несовместим. Нужны Node >=22.22.2, typescript-language-server 6.0.1 и TypeScript 6 вне проекта.`,
    );
  }
}
