import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import { RuntimeError } from "../runtime/errors.js";
import { isReadEffect } from "../tools/effects.js";
import { canonicalInput } from "../tools/invocation.js";
import type { JsonObject } from "../types/domain.js";
import { classifyMcpTool, type McpClassification } from "./classification.js";
import type {
  McpCallResult,
  McpConnection,
  McpConnectionInfo,
  McpConnectionState,
  McpProgress,
} from "./connection.js";
import {
  type McpAuthentication,
  McpCredentialResolver,
} from "./credentials.js";
import { mcpError } from "./errors.js";
import { McpRedactor } from "./redaction.js";
import type { McpPermissions } from "./schema.js";
import type { McpConfigStore, McpServerEntry } from "./storage.js";
import {
  type McpConnectionFactory,
  sdkMcpConnectionFactory,
} from "./transports.js";

export interface McpToolInfo {
  tool: Tool;
  classification: McpClassification;
  fingerprint: string;
}
export interface McpDiagnostic {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}
export interface McpServerStatus {
  id: string;
  label: string;
  scope: "global" | "project";
  state: McpConnectionState;
  trusted: boolean;
  enabled: boolean;
  transport: "stdio" | "http" | "unknown";
  configurationError?: string;
  toolsCount: number;
  info?: McpConnectionInfo;
  latencyMs?: number;
  lastError?: { code: string; message: string; retryable: boolean };
  restartAttempts: number;
}
interface ServerRecord {
  entry: McpServerEntry;
  status: McpServerStatus;
  tools: McpToolInfo[];
  diagnostics: McpDiagnostic[];
  connection?: McpConnection;
  connecting?: Promise<void>;
  opening?: AbortController;
  generation: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  refresh?: Promise<void>;
}
export class McpConnectionManager {
  readonly redactor = new McpRedactor();
  private records = new Map<string, ServerRecord>();
  private invalid: McpServerStatus[] = [];
  private listeners = new Set<() => void>();
  private paused = new Set<string>();
  private disposed = false;
  private loading?: Promise<void>;
  private readonly factory: McpConnectionFactory;
  private readonly maxRestarts: number;
  private readonly retryDelay: number;
  constructor(
    readonly store: McpConfigStore,
    options: {
      credentials?: McpCredentialResolver;
      authentication?: McpAuthentication;
      factory?: McpConnectionFactory;
      maxRestarts?: number;
      retryDelayMs?: number;
    } = {},
  ) {
    this.factory =
      options.factory ??
      sdkMcpConnectionFactory(
        options.credentials ?? new McpCredentialResolver(),
        this.redactor,
        options.authentication,
      );
    this.maxRestarts = options.maxRestarts ?? 3;
    this.retryDelay = options.retryDelayMs ?? 1000;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  list(): McpServerStatus[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record.status))
      .concat(structuredClone(this.invalid));
  }
  status(id: string): McpServerStatus | undefined {
    const status =
      this.records.get(id)?.status ??
      this.invalid.find((status) => status.id === id);
    return status && structuredClone(status);
  }
  entry(id: string): McpServerEntry {
    const value = this.records.get(id)?.entry;
    if (!value)
      throw new RuntimeError(
        "MCP_SERVER_UNAVAILABLE",
        "MCP-сервер не настроен.",
        { retryable: false },
      );
    return structuredClone(value);
  }
  tools(id: string): McpToolInfo[] {
    return structuredClone(this.records.get(id)?.tools ?? []);
  }
  logs(id: string): McpDiagnostic[] {
    const invalid = this.invalid.find((status) => status.id === id);
    if (invalid)
      return [
        {
          timestamp: new Date().toISOString(),
          level: "error",
          message: invalid.configurationError ?? "Невалидная конфигурация.",
        },
      ];
    return structuredClone(this.records.get(id)?.diagnostics ?? []);
  }
  report(id: string, level: McpDiagnostic["level"], text: string): void {
    const record = this.records.get(id);
    if (record) this.log(record, level, text);
  }
  private log(
    record: ServerRecord,
    level: McpDiagnostic["level"],
    text: string,
  ): void {
    const message = this.redactor.text(text).slice(0, 1500).trim();
    if (!message) return;
    record.diagnostics.push({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    record.diagnostics = record.diagnostics.slice(-80);
  }
  async reload(): Promise<void> {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    const task = this.loadRecords();
    this.loading = task;
    try {
      await task;
    } finally {
      if (this.loading === task) this.loading = undefined;
    }
  }
  private async loadRecords(): Promise<void> {
    const entries = await this.store.load();
    const invalid: McpServerStatus[] = this.store.diagnostics.map(
      (diagnostic) => ({
        id: entries.some((entry) => entry.id === diagnostic.id)
          ? `${diagnostic.scope}:${diagnostic.id}`
          : diagnostic.id,
        label: diagnostic.id,
        scope: diagnostic.scope ?? "global",
        state: "error",
        trusted: false,
        enabled: false,
        transport: "unknown",
        toolsCount: 0,
        restartAttempts: 0,
        configurationError: diagnostic.message,
        lastError: {
          code: "MCP_PROTOCOL_ERROR",
          message: diagnostic.message,
          retryable: false,
        },
      }),
    );
    let changed = JSON.stringify(this.invalid) !== JSON.stringify(invalid);
    this.invalid = invalid;
    for (const [id, record] of this.records)
      if (!entries.some((entry) => entry.id === id)) {
        await this.closeRecord(record);
        this.records.delete(id);
        changed = true;
      }
    for (const entry of entries) {
      const previous = this.records.get(entry.id);
      const sameConnection =
        previous &&
        canonicalInput({
          transport: previous.entry.config.transport,
          env: previous.entry.config.env,
          auth: previous.entry.config.auth,
          startup: previous.entry.config.startupTimeoutMs,
          timeout: previous.entry.config.callTimeoutMs,
        }) ===
          canonicalInput({
            transport: entry.config.transport,
            env: entry.config.env,
            auth: entry.config.auth,
            startup: entry.config.startupTimeoutMs,
            timeout: entry.config.callTimeoutMs,
          });
      if (
        previous &&
        previous.entry.trusted === entry.trusted &&
        previous.entry.config.enabled === entry.config.enabled &&
        (previous.entry.fingerprint === entry.fingerprint ||
          (entry.scope === "global" && sameConnection))
      ) {
        if (previous.entry.fingerprint !== entry.fingerprint) changed = true;
        previous.entry = entry;
        previous.status.label = entry.config.label ?? entry.id;
        continue;
      }
      if (previous) await this.closeRecord(previous);
      const record: ServerRecord = {
        entry,
        generation: 0,
        tools: [],
        diagnostics: [],
        status: {
          id: entry.id,
          label: entry.config.label ?? entry.id,
          scope: entry.scope,
          enabled: entry.config.enabled,
          trusted: entry.trusted,
          state: entry.config.enabled ? "disconnected" : "disabled",
          transport: entry.config.transport.type,
          toolsCount: 0,
          restartAttempts: 0,
        },
      };
      this.records.set(entry.id, record);
      changed = true;
      this.log(
        record,
        "info",
        entry.trusted
          ? "Конфигурация загружена."
          : "Конфигурация проекта ожидает явного доверия; запуск заблокирован.",
      );
    }
    if (changed) this.changed();
  }
  async startEnabled(signal?: AbortSignal): Promise<void> {
    await this.reload();
    await Promise.all(
      [...this.records.values()]
        .filter(
          (record) =>
            record.entry.config.enabled &&
            record.entry.trusted &&
            !this.paused.has(record.entry.id) &&
            (record.status.state === "disconnected" ||
              record.status.state === "connecting"),
        )
        .map((record) => this.connect(record.entry.id, signal).catch(() => {})),
    );
  }
  async connect(
    id: string,
    signal?: AbortSignal,
    restart = false,
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record || this.disposed)
      throw new RuntimeError(
        "MCP_SERVER_UNAVAILABLE",
        "MCP-сервер недоступен.",
        { retryable: false },
      );
    if (!record.entry.config.enabled)
      throw new RuntimeError("MCP_SERVER_UNAVAILABLE", "MCP-сервер отключён.", {
        retryable: false,
      });
    if (!record.entry.trusted)
      throw new RuntimeError(
        "MCP_TRUST_REQUIRED",
        "Откройте /mcp и проверьте конфигурацию проекта перед запуском.",
        { retryable: false },
      );
    if (signal?.aborted)
      throw new RuntimeError("MCP_CANCELLED", "Подключение отменено.");
    if (record.status.state === "connected") return;
    if (record.connecting)
      return this.waitForConnection(record.connecting, signal);
    this.paused.delete(id);
    if (!restart) record.status.restartAttempts = 0;
    const generation = ++record.generation;
    // The manager owns the shared connection. A tab can cancel its own wait,
    // but must not cancel initialization being used by another tab.
    const opening = new AbortController();
    record.opening = opening;
    const task = this.openRecord(record, generation, opening.signal, restart);
    record.connecting = task;
    void task
      .finally(() => {
        if (record.connecting === task) record.connecting = undefined;
        if (record.opening === opening) record.opening = undefined;
      })
      .catch(() => {});
    await this.waitForConnection(task, signal);
  }
  private async waitForConnection(
    task: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!signal) return task;
    if (signal.aborted)
      throw new RuntimeError("MCP_CANCELLED", "Ожидание подключения отменено.");
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new RuntimeError("MCP_CANCELLED", "Ожидание подключения отменено."),
        );
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([task, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async openRecord(
    record: ServerRecord,
    generation: number,
    signal: AbortSignal | undefined,
    restart: boolean,
  ): Promise<void> {
    record.status.state = restart ? "reconnecting" : "connecting";
    this.changed();
    const started = performance.now();
    const deadline = AbortSignal.timeout(record.entry.config.startupTimeoutMs);
    const connectSignal = signal
      ? AbortSignal.any([deadline, signal])
      : deadline;
    let connection: McpConnection | undefined;
    try {
      connection = this.factory(record.entry, {
        closed: () => {
          if (record.generation === generation && !this.disposed)
            this.lost(
              record,
              "Соединение закрыто; локальный процесс мог завершиться.",
            );
        },
        error: (error) => {
          if (record.generation === generation) {
            this.log(record, "error", mcpError(error, this.redactor).message);
            this.changed();
          }
        },
        stderr: (text) => {
          if (record.generation === generation) {
            this.log(record, "warn", text);
            this.changed();
          }
        },
        toolsChanged: () => {
          if (
            record.generation === generation &&
            record.status.state === "connected"
          )
            void this.refreshTools(record.entry.id).catch(() => {});
        },
      });
      record.connection = connection;
      const info = await connection.initialize(connectSignal);
      const tools = info.capabilities.tools
        ? await connection.listTools(connectSignal)
        : [];
      if (record.generation !== generation || this.disposed) {
        await connection.close();
        return;
      }
      record.tools = this.toolInfos(record, tools);
      record.status = {
        ...record.status,
        state: "connected",
        info: this.redactor.value(info),
        latencyMs: Math.round(performance.now() - started),
        toolsCount: record.tools.length,
        lastError: undefined,
      };
      this.log(
        record,
        "info",
        `Подключено. Протокол ${info.protocolVersion}; инструментов: ${record.tools.length}.`,
      );
      this.changed();
    } catch (error) {
      const typed = mcpError(
        error,
        this.redactor,
        "MCP_CONNECTION_FAILED",
        signal,
      );
      if (record.generation === generation) {
        ++record.generation;
        record.connection = undefined;
        record.tools = [];
        record.status.toolsCount = 0;
        record.status.state =
          typed.code === "MCP_AUTH_REQUIRED"
            ? "authentication_required"
            : signal?.aborted
              ? "disconnected"
              : "error";
        record.status.lastError = {
          code: typed.code,
          message: typed.message,
          retryable: typed.details?.retryable === true,
        };
        this.log(record, "error", typed.message);
        this.changed();
      }
      await connection?.close().catch(() => {});
      throw typed;
    }
  }
  private toolInfos(record: ServerRecord, tools: Tool[]): McpToolInfo[] {
    if (
      tools.length > 1000 ||
      Buffer.byteLength(JSON.stringify(tools)) > 4 * 1024 * 1024
    )
      throw new RuntimeError(
        "MCP_PROTOCOL_ERROR",
        "Список MCP-инструментов превышает безопасный размер.",
      );
    const names = new Map<string, number>();
    for (const tool of tools)
      names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
    return tools.flatMap((raw) => {
      if (
        !/^[A-Za-z0-9_.:-]{1,95}$/.test(raw.name) ||
        names.get(raw.name) !== 1
      ) {
        this.log(
          record,
          "warn",
          "Инструмент с недопустимым или повторяющимся именем пропущен.",
        );
        return [];
      }
      if (this.redactor.text(raw.name) !== raw.name) {
        this.log(
          record,
          "warn",
          "Инструмент с секретным значением в имени отключён.",
        );
        return [];
      }
      const classification = classifyMcpTool(raw, {
        localProcess: record.entry.config.transport.type === "stdio",
      });
      const fingerprint = createHash("sha256")
        .update(canonicalInput(raw))
        .digest("hex");
      const tool = this.redactor.value(raw);
      tool.description = tool.description?.slice(0, 8000);
      tool.title = tool.title?.slice(0, 120);
      return [{ tool, classification, fingerprint }];
    });
  }
  async refreshTools(id: string, signal?: AbortSignal): Promise<void> {
    const record = this.records.get(id);
    if (!record?.connection || record.status.state !== "connected")
      throw new RuntimeError("MCP_SERVER_UNAVAILABLE", "Сервер не подключён.", {
        retryable: true,
      });
    if (record.refresh) return record.refresh;
    const generation = record.generation;
    const task = (async () => {
      const tools = await record.connection?.listTools(signal);
      if (generation !== record.generation || !tools) return;
      record.tools = this.toolInfos(record, tools);
      record.status.toolsCount = record.tools.length;
      this.log(
        record,
        "info",
        `Список обновлён: ${record.tools.length} инструментов.`,
      );
      this.changed();
    })().catch((error) => {
      const typed = mcpError(
        error,
        this.redactor,
        "MCP_PROTOCOL_ERROR",
        signal,
      );
      this.log(record, "error", typed.message);
      throw typed;
    });
    record.refresh = task;
    try {
      await task;
    } finally {
      if (record.refresh === task) record.refresh = undefined;
    }
  }
  async invoke(
    id: string,
    name: string,
    fingerprint: string,
    input: JsonObject,
    signal?: AbortSignal,
    progress?: (value: McpProgress) => void,
  ): Promise<McpCallResult> {
    const record = this.records.get(id);
    if (
      !record?.connection ||
      record.status.state !== "connected" ||
      !record.entry.config.enabled ||
      !record.entry.trusted ||
      this.disposed
    )
      throw new RuntimeError(
        "MCP_SERVER_UNAVAILABLE",
        "MCP-сервер недоступен. Локальные инструменты остаются доступны.",
        { retryable: true },
      );
    const tool = record.tools.find((item) => item.tool.name === name);
    if (!tool)
      throw new RuntimeError(
        "MCP_TOOL_NOT_FOUND",
        "Инструмент удалён с сервера.",
        { retryable: false },
      );
    if (tool.fingerprint !== fingerprint)
      throw new RuntimeError(
        "MCP_TOOL_CHANGED",
        "Инструмент изменился после подготовки. Используйте обновлённый список и новый вызов.",
        { retryable: true },
      );
    try {
      const result = await record.connection.callTool(
        name,
        input,
        signal,
        (value) => progress?.(this.redactor.value(value)),
      );
      return this.redactor.value(result);
    } catch (error) {
      const typed = mcpError(
        error,
        this.redactor,
        "MCP_TOOL_CALL_FAILED",
        signal,
      );
      this.log(record, "error", typed.message);
      if (typed.code === "MCP_AUTH_REQUIRED") {
        record.status.state = "authentication_required";
        this.changed();
      } else if (typed.details?.retryable === true && !signal?.aborted)
        this.lost(record, typed.message);
      if (
        !isReadEffect(tool.classification.effect) &&
        typed.details?.retryable === true
      )
        throw new RuntimeError(
          typed.code,
          `${typed.message} Перед повторным вызовом проверьте внешний ресурс: действие могло выполниться.`,
          { ...typed.details, retryable: false, executionUnknown: true },
        );
      throw typed;
    }
  }
  private lost(record: ServerRecord, message: string): void {
    if (
      this.paused.has(record.entry.id) ||
      !record.entry.config.enabled ||
      this.disposed ||
      record.retryTimer
    )
      return;
    record.status.lastError = {
      code: "MCP_SERVER_UNAVAILABLE",
      message: this.redactor.text(message),
      retryable: true,
    };
    record.tools = [];
    record.status.toolsCount = 0;
    if (record.status.restartAttempts >= this.maxRestarts) {
      record.status.state = "error";
      this.log(
        record,
        "error",
        "Автоматическое переподключение остановлено после нескольких попыток.",
      );
      this.changed();
      return;
    }
    record.status.state = "reconnecting";
    record.status.restartAttempts++;
    const delay = Math.min(
      10_000,
      this.retryDelay * 2 ** (record.status.restartAttempts - 1),
    );
    this.log(
      record,
      "warn",
      `Соединение потеряно. Попытка ${record.status.restartAttempts}/${this.maxRestarts}.`,
    );
    record.retryTimer = setTimeout(() => {
      record.retryTimer = undefined;
      void (async () => {
        await this.closeRecord(record, false);
        if (this.disposed || this.paused.has(record.entry.id)) return;
        try {
          await this.connect(record.entry.id, undefined, true);
        } catch {
          this.lost(record, "Повторное подключение не удалось.");
        }
      })();
    }, delay);
    record.retryTimer.unref?.();
    this.changed();
  }
  private async closeRecord(record: ServerRecord, reset = true): Promise<void> {
    const connecting = record.connecting;
    ++record.generation;
    record.opening?.abort();
    record.opening = undefined;
    record.connecting = undefined;
    if (record.retryTimer) clearTimeout(record.retryTimer);
    record.retryTimer = undefined;
    const connection = record.connection;
    record.connection = undefined;
    record.tools = [];
    record.status.toolsCount = 0;
    if (reset)
      record.status.state = record.entry.config.enabled
        ? "disconnected"
        : "disabled";
    await connection?.close().catch(() => {});
    // SDK negotiation may still own a probe process or attach a transport.
    // Wait for the aborted startup to settle, then close that late transport too.
    await connecting?.catch(() => {});
    await connection?.close().catch(() => {});
  }
  async disconnect(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.paused.add(id);
    await this.closeRecord(record);
    this.changed();
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entry(id);
    await this.store.save(id, { ...entry.config, enabled }, entry.scope);
    await this.reload();
    if (enabled) this.paused.delete(id);
    else this.paused.add(id);
  }
  async trust(
    id: string,
    fingerprint: string,
    permissions: McpPermissions,
  ): Promise<void> {
    const entry = this.entry(id);
    if (entry.fingerprint !== fingerprint)
      throw new Error("Конфигурация изменилась. Проверьте её заново.");
    await this.store.trust(entry, permissions);
    await this.reload();
  }
  async setPermissions(id: string, permissions: McpPermissions): Promise<void> {
    await this.store.setPermissions(this.entry(id), permissions);
    await this.reload();
  }
  async rememberTool(
    id: string,
    name: string,
    fingerprint: string,
  ): Promise<void> {
    const tool = this.tools(id).find((item) => item.tool.name === name);
    if (!tool || tool.fingerprint !== fingerprint)
      throw new RuntimeError(
        "MCP_TOOL_CHANGED",
        "Инструмент изменился во время подтверждения.",
        { retryable: false },
      );
    await this.store.rememberTool(
      this.entry(id),
      name,
      tool.classification.category,
    );
    await this.reload();
  }
  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.store.remove(this.entry(id));
    await this.reload();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.records.values()].map((record) => this.closeRecord(record)),
    );
    this.listeners.clear();
  }
}
