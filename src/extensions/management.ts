import { createHash } from "node:crypto";
import { z } from "zod";
import { effectiveBackgroundConfig } from "../background/config.js";
import { BackgroundSettingsStore } from "../background/settings.js";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import type {
  BuiltinSettings,
  CatalogExtension,
  ExtensionCatalog,
  ExtensionOperation,
  ExtensionResult,
  ExtensionReview,
  ExtensionSettings,
  Json,
  RequestMap,
} from "../desktop/protocol.js";
import {
  effectiveLspMode,
  globalLspMode,
  LspConfigSchema,
  LspServerSchema,
  ProjectLspConfigSchema,
} from "../lsp/config.js";
import { type LspSettingsRuntime, LspSettingsStore } from "../lsp/settings.js";
import { effectiveSubagentConfig } from "../subagents/config.js";
import { SubagentSettingsStore } from "../subagents/settings.js";
import { VERSION } from "../version.js";
import {
  type ExtensionDiagnostic,
  safeExtensionText,
} from "./external/loader.js";
import {
  type ExtensionManifest,
  ExternalIdSchema,
} from "./external/manifest.js";
import { inspectPackage } from "./external/package.js";
import {
  readExtensionRegistry,
  receiptMatches,
  runtimeRecord,
  selectedVersion,
  withExtensionRegistry,
} from "./external/registry.js";
import { frozenClone } from "./lifecycle.js";
import { PackageManagementError } from "./packages/errors.js";
import {
  PackageManagementService,
  type PreparedPackage,
} from "./packages/service.js";
import { ExtensionSettingsStore } from "./settings-store.js";

const builtinNames = {
  "builtin.lsp": [
    "Анализ кода (LSP)",
    "Ошибки, определения и ссылки в коде",
    "tools.lsp",
  ],
  "builtin.subagents": [
    "Субагенты",
    "Помощники для чтения и работы в отдельных копиях",
    "tools.subagents",
  ],
  "builtin.background": [
    "Фоновые задачи",
    "Длительные локальные команды и их результаты",
    "tools.background",
  ],
  "builtin.worktrees": [
    "Рабочие копии",
    "Изолированные папки для независимых задач",
  ],
  "builtin.project": ["Проект", "Контекст и сведения о проекте"],
  "builtin.btw": [
    "Побочные вопросы",
    "Дополнительный вопрос в терминальной оболочке",
  ],
} as const;
export const BuiltinIdSchema = z.enum([
  "builtin.lsp",
  "builtin.subagents",
  "builtin.background",
]);
type BuiltinId = z.infer<typeof BuiltinIdSchema>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function actualLabel(state: string): string {
  const labels: Record<string, string> = {
    active: "Работает",
    available: "Доступно в рабочем сеансе",
    not_started: "Не загружено в этом рабочем сеансе",
    loading: "Загружается",
    disabled: "Выключено в текущем рабочем сеансе",
    not_trusted: "Код не загружен: доверие не выдано",
    incompatible: "Код не загружен: несовместим",
    modified: "Код не загружен: содержимое изменено",
    invalid: "Код не загружен: пакет повреждён",
    load_failed: "Ошибка загрузки",
    activation_failed: "Ошибка активации",
    cleanup_failed: "Ошибка очистки ресурсов",
    unavailable: "Недоступно в этой оболочке",
    pending_restart: "Ожидает запуска рабочего сеанса",
  };
  return labels[state] ?? "Не работает";
}
function conflict(
  message = "Состояние изменилось после просмотра. Перечитайте список и подтвердите заново.",
): never {
  throw new PackageManagementError("PACKAGE_CONFLICT", message);
}
interface Operation {
  dto: ExtensionOperation;
  input: string;
  abort: AbortController;
  pending?: Promise<ExtensionReview>;
  candidate?: PreparedPackage;
  versionKey?: string;
  selectedDigest?: string;
  registryRevision?: number;
  commit?: Promise<ExtensionResult>;
  confirmation?: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface Options {
  configPath?: string;
  diagnostics?: (root?: string) => readonly ExtensionDiagnostic[];
  scopeReady?: (root: string) => boolean;
  lsp?: (root: string) => LspSettingsRuntime;
  applySubagents?: () => Promise<void>;
  externalDisabled?: boolean;
  desktop?: boolean;
}
/** One shared application service. UI receives data, never prepared handles. */
export class ExtensionManagementService {
  readonly packages = new PackageManagementService();
  private operations = new Map<string, Operation>();
  private closed = false;
  constructor(private readonly options: Options = {}) {}
  private lsp(root: string) {
    return new LspSettingsStore(
      root,
      this.options.configPath,
      this.options.lsp?.(root) ?? {
        status: async () => ({
          workspaceRoot: root,
          backend: "typescript",
          state: "unavailable",
          generation: 0,
          trackedDocuments: 0,
          requiresRestart: false,
          reason:
            "Рабочий сеанс LSP ещё не открыт; просмотр настроек его не запускает.",
        }),
        apply: async () => {},
        restart: async () => ({
          output: "Сначала откройте рабочий сеанс проекта.",
          isError: true,
        }),
      },
    );
  }
  private store(id: BuiltinId, root: string) {
    return id === "builtin.lsp"
      ? this.lsp(root)
      : id === "builtin.subagents"
        ? new SubagentSettingsStore(
            root,
            this.options.configPath,
            this.options.applySubagents,
          )
        : new BackgroundSettingsStore(root, this.options.configPath);
  }
  async builtinRead(id: string, root: string): Promise<BuiltinSettings> {
    const state = await this.store(BuiltinIdSchema.parse(id), root).load();
    return frozenClone({
      id,
      global: state.global as unknown as Json,
      project: state.project as unknown as Json,
      globalRevision: state.globalRevision,
      projectRevision: state.projectRevision,
      ...("effective" in state
        ? { effective: state.effective as unknown as Json }
        : { status: state.status as unknown as Json }),
    });
  }
  async builtinSave(
    input: RequestMap["extensions/builtin/save"]["params"],
  ): Promise<BuiltinSettings> {
    const id = BuiltinIdSchema.parse(input.id),
      store = this.store(id, input.path);
    if (id === "builtin.lsp") {
      const lsp = store as LspSettingsStore;
      if (input.scope === "global")
        await lsp.saveGlobal(
          LspConfigSchema.parse(input.value),
          input.revision,
        );
      else
        await lsp.saveProject(
          ProjectLspConfigSchema.parse(input.value),
          input.revision,
        );
    } else if (id === "builtin.subagents") {
      const subagents = store as SubagentSettingsStore;
      if (input.scope === "global")
        await subagents.saveGlobal(
          input.value as Parameters<typeof subagents.saveGlobal>[0],
          input.revision,
        );
      else
        await subagents.saveProject(
          input.value as Parameters<typeof subagents.saveProject>[0],
          input.revision,
        );
    } else {
      const background = store as BackgroundSettingsStore;
      if (input.scope === "global")
        await background.saveGlobal(
          input.value as Parameters<typeof background.saveGlobal>[0],
          input.revision,
        );
      else
        await background.saveProject(
          input.value as Parameters<typeof background.saveProject>[0],
          input.revision,
        );
    }
    return this.builtinRead(id, input.path);
  }
  async lspAction(
    input: RequestMap["extensions/lsp/action"]["params"],
  ): Promise<{ text: string }> {
    const store = this.lsp(input.path);
    if (input.action === "trust") {
      await store.trust(input.serverId, input.allowed === true);
      return { text: "Доверие проекта сохранено." };
    }
    if (input.action === "check")
      return {
        text: await store.check(
          input.serverId,
          LspServerSchema.parse(input.value),
        ),
      };
    const result = await store.restart(input.serverId);
    if (result.isError) throw new Error(result.output);
    return { text: safeExtensionText(result.output) };
  }
  async list(root?: string): Promise<ExtensionCatalog> {
    const [global, project, packages, registry] = await Promise.all([
      loadGlobalConfig(this.options.configPath),
      root ? loadProjectConfig(root) : undefined,
      this.packages.list(),
      readExtensionRegistry(),
    ]);
    const diagnostics = this.options.diagnostics?.(root) ?? [];
    const items: CatalogExtension[] = Object.entries(builtinNames).map(
      ([id, metadata]) => {
        let enabled = true,
          effective = true,
          configuration: unknown = {};
        if (id === "builtin.lsp") {
          configuration = global.lsp ?? { servers: {} };
          const lsp = LspConfigSchema.parse(configuration);
          enabled = globalLspMode(lsp) !== "off";
          effective =
            effectiveLspMode({
              global: lsp,
              project: project?.lsp,
              ignorePatterns: [],
            }) !== "off";
        }
        if (id === "builtin.subagents") {
          configuration = global.subagents ?? {};
          enabled = effectiveSubagentConfig(global.subagents).enabled;
          effective = effectiveSubagentConfig(
            global.subagents,
            project?.subagents,
          ).enabled;
        }
        if (id === "builtin.background") {
          configuration = global.backgroundTasks ?? {};
          enabled = effectiveBackgroundConfig(global.backgroundTasks).enabled;
          effective = effectiveBackgroundConfig(
            global.backgroundTasks,
            project?.backgroundTasks,
          ).enabled;
        }
        const route = metadata[
          2 as keyof typeof metadata
        ] as CatalogExtension["settingsRoute"];
        const desktopUnavailable = this.options.desktop && id === "builtin.btw";
        return {
          id,
          name: metadata[0],
          description: metadata[1],
          origin: "builtin",
          version: VERSION,
          source: "Встроено в ChiselCode",
          revision: 0,
          digest: hash(configuration),
          compatible: !desktopUnavailable,
          compatibility: desktopUnavailable
            ? "Побочные вопросы доступны в CLI"
            : `ChiselCode ${VERSION}`,
          trusted: true,
          desiredEnabled: enabled,
          actualState: !effective
            ? "disabled"
            : desktopUnavailable
              ? "unavailable"
              : root && this.options.scopeReady?.(root)
                ? "available"
                : "not_started",
          state: !effective
            ? "disabled"
            : desktopUnavailable
              ? "saved"
              : root && this.options.scopeReady?.(root)
                ? "working"
                : "saved",
          actualLabel: !effective
            ? actualLabel("disabled")
            : desktopUnavailable
              ? actualLabel("unavailable")
              : root && this.options.scopeReady?.(root)
                ? actualLabel("available")
                : actualLabel("not_started"),
          projectBlocked: enabled && !effective,
          restartRequired: false,
          deferredRemoval: false,
          actions:
            route && root ? [enabled ? "disable" : "enable", "settings"] : [],
          ...(route ? { settingsRoute: route } : {}),
          versions: [],
          ...(!effective && enabled
            ? { reason: "Возможность запрещена настройками этого проекта." }
            : desktopUnavailable
              ? { reason: "Используйте CLI для /btw." }
              : {}),
        };
      },
    );
    for (const row of packages) {
      const actual = diagnostics.find((d) => d.id === row.id),
        selected = row.selected;
      if (row.removed && !row.versions.length && !actual) continue;
      const blocked =
        !!this.options.externalDisabled ||
        !!project?.externalExtensions?.disabled ||
        !!project?.externalExtensions?.disabledIds?.includes(row.id);
      let manifest: ExtensionManifest | undefined;
      if (selected && !row.removed)
        try {
          manifest = (await inspectPackage(selected.location)).manifest;
        } catch {
          /* The package status already reports damage. */
        }
      const loaded = actual?.state === "active";
      let settingsRevision = 0,
        settingsError: string | undefined;
      if (manifest)
        try {
          const settings = await new ExtensionSettingsStore(manifest).read();
          settingsRevision = settings.revision;
          if (settings.issues.length) settingsError = settings.issues.join(" ");
        } catch {
          settingsError =
            "Настройки расширения недоступны или повреждены; данные сохранены.";
        }
      const restart = loaded
        ? row.removed ||
          !row.enabled ||
          selected?.digest !== actual.packageDigest ||
          actual.settingsRevision !== settingsRevision
        : row.enabled &&
          !blocked &&
          row.trusted &&
          row.compatible &&
          !row.removed &&
          !actual;
      const failure =
        (!!settingsError && row.trusted) ||
        ["invalid", "modified", "incompatible"].includes(row.state) ||
        (!!actual &&
          ["load_failed", "activation_failed", "cleanup_failed"].includes(
            actual.state,
          ));
      const state: CatalogExtension["state"] = failure
        ? "error"
        : restart
          ? "restart_required"
          : loaded
            ? "working"
            : !row.trusted && !row.removed
              ? "not_trusted"
              : !row.enabled || blocked || row.removed
                ? "disabled"
                : "saved";
      const actions: CatalogExtension["actions"] = row.removed
        ? []
        : [
            ...(manifest ? ["settings" as const] : []),
            "update",
            "versions",
            "remove",
          ];
      if (!row.removed && row.enabled) actions.unshift("disable");
      else if (
        !row.removed &&
        row.trusted &&
        row.compatible &&
        !failure &&
        !blocked
      )
        actions.unshift("enable");
      if (
        !row.removed &&
        !row.trusted &&
        row.compatible &&
        row.state === "not_trusted"
      )
        actions.unshift("trust");
      items.push({
        id: row.id,
        name: row.name,
        description: safeExtensionText(manifest?.description ?? ""),
        origin: "installed",
        version: selected?.version ?? actual?.version ?? "—",
        source:
          selected?.source ?? selected?.location ?? "Удалённое подключение",
        ...(selected ? { digest: selected.digest } : {}),
        revision: row.revision,
        compatible: row.compatible,
        compatibility:
          manifest?.chiselVersion ??
          (row.compatible ? "API v1" : "Не прошёл проверку совместимости"),
        trusted: row.trusted,
        desiredEnabled: row.enabled,
        actualState: actual?.state ?? "not_started",
        actualLabel: actualLabel(actual?.state ?? "not_started"),
        state,
        projectBlocked: blocked,
        restartRequired: !!restart,
        deferredRemoval:
          row.removed && row.versions.some((v) => v.kind === "managed"),
        actions,
        ...(failure
          ? {
              reason:
                settingsError ??
                actual?.reason ??
                row.reason ??
                "Содержимое изменено или несовместимо.",
            }
          : blocked
            ? {
                reason:
                  "Внешнее расширение запрещено для этого проекта/запуска.",
              }
            : row.removed
              ? {
                  reason:
                    "Подключение удалено. Занятые или не подтверждённые файлы сохранены; пользовательские данные остаются.",
                }
              : {}),
        versions: row.versions.map((v) => ({
          key: v.key,
          version: v.version,
          digest: v.digest,
          selected: v.key === selected?.key,
          trusted: !!v.approvedAt,
          inUse: row.uses.some((u) => u.digest === v.digest),
          location: v.location,
        })),
      });
    }
    return frozenClone({ items, revision: registry.revision });
  }
  prepare(
    input: RequestMap["extensions/prepare"]["params"],
  ): Promise<ExtensionReview> {
    if (this.closed) throw new Error("Управление расширениями закрыто.");
    z.uuid().parse(input.requestId);
    const signature = JSON.stringify(input),
      existing = this.operations.get(input.requestId);
    if (existing) {
      if (existing.input !== signature)
        conflict("Идентификатор операции уже занят.");
      if (existing.pending) return existing.pending;
      if (existing.dto.review) return Promise.resolve(existing.dto.review);
      conflict();
    }
    for (const [key, op] of this.operations)
      if (
        this.operations.size >= 64 &&
        ["completed", "cancelled", "error"].includes(op.dto.phase)
      )
        this.operations.delete(key);
    if (
      this.operations.size >= 64 ||
      [...this.operations.values()].filter((op) =>
        ["preparing", "review", "committing"].includes(op.dto.phase),
      ).length >= 8
    )
      throw new Error("Сначала завершите открытые операции расширений.");
    const op: Operation = {
      dto: { requestId: input.requestId, phase: "preparing" },
      input: signature,
      abort: new AbortController(),
    };
    this.operations.set(input.requestId, op);
    op.pending = this.prepareOperation(input, op)
      .then((review) => {
        if (op.abort.signal.aborted) throw new Error("Операция отменена.");
        op.dto = { ...op.dto, phase: "review", review };
        op.timer = setTimeout(() => {
          void this.cancel(input.requestId).catch(() => {});
        }, 30 * 60_000);
        op.timer.unref();
        return review;
      })
      .catch(async (error) => {
        if (op.candidate) await this.packages.abortCandidate(op.candidate);
        op.dto = {
          ...op.dto,
          phase: op.abort.signal.aborted ? "cancelled" : "error",
          error: safeExtensionText(
            error instanceof Error
              ? error.message
              : "Не удалось проверить пакет.",
          ),
        };
        throw error;
      });
    return op.pending;
  }
  private async prepareOperation(
    input: RequestMap["extensions/prepare"]["params"],
    op: Operation,
  ): Promise<ExtensionReview> {
    if (input.kind === "install" || input.kind === "update") {
      if (!input.source || (input.kind === "update" && !input.id))
        throw new Error("Выберите подготовленную папку или ZIP.");
      const options = {
        signal: op.abort.signal,
        progress: (progress: NonNullable<ExtensionOperation["progress"]>) => {
          op.dto.progress = progress;
        },
      };
      op.candidate =
        input.kind === "install"
          ? await this.packages.prepareInstall(input.source, options)
          : await this.packages.prepareUpdate(input.id!, input.source, options);
      const p = op.candidate.preview,
        registry = await readExtensionRegistry();
      op.selectedDigest = p.oldDigest;
      if (p.expectedRevision === undefined)
        op.registryRevision = registry.revision;
      return frozenClone({
        kind: p.kind,
        id: p.id,
        name: p.name,
        version: p.version,
        digest: p.digest,
        location: p.location,
        bytes: p.bytes,
        files: p.files,
        sourceKind: p.sourceKind,
        oldVersion: p.oldVersion,
        oldDigest: p.oldDigest,
        incompatible: p.incompatible,
        requestedEnabled: p.requestedEnabled,
        trustRequired: p.trustRequired,
        downgrade: p.downgrade,
        description: p.description,
        entry: p.entry,
        compatibility: p.compatibility,
        requestId: input.requestId,
        revision: p.expectedRevision ?? registry.revision,
        contents: [...p.contents],
      });
    }
    const row = await this.packages.status(ExternalIdSchema.parse(input.id)),
      version =
        input.kind === "rollback"
          ? row.versions.find((v) => v.key === input.versionKey)
          : row.selected;
    if (!version || row.removed) conflict("Выбранная версия недоступна.");
    op.versionKey = version.key;
    op.selectedDigest = row.selected?.digest;
    const candidate =
      input.kind === "remove"
        ? undefined
        : await inspectPackage(version.location, op.abort.signal);
    if (candidate && candidate.digest !== version.digest)
      conflict("Сохранённая версия изменена; подготовьте новый пакет.");
    const trusted =
      !!candidate &&
      receiptMatches({ ...version, enabled: row.enabled }, candidate);
    return frozenClone({
      requestId: input.requestId,
      kind: input.kind,
      id: row.id,
      name: version.name ?? row.name,
      version: version.version,
      digest: version.digest,
      revision: row.revision,
      oldVersion: row.selected?.version,
      oldDigest: row.selected?.digest,
      location: version.location,
      bytes: version.bytes,
      files: version.files,
      incompatible: candidate?.incompatible,
      downgrade: input.kind === "rollback",
      trustRequired:
        input.kind === "trust" || (input.kind === "rollback" && !trusted),
      requestedEnabled: row.enabled,
      description: safeExtensionText(candidate?.manifest.description ?? ""),
      entry: version.entry,
      compatibility: candidate?.manifest.chiselVersion ?? "API v1",
      contents:
        candidate?.contents.map((f) => ({
          ...f,
          path: safeExtensionText(f.path),
        })) ?? [],
    });
  }
  operation(requestId: string): ExtensionOperation {
    const op = this.operations.get(requestId);
    if (!op) conflict("Операция недоступна; перечитайте список.");
    return frozenClone(op.dto);
  }
  async cancel(requestId: string): Promise<{ ok: boolean }> {
    const op = this.operations.get(requestId);
    if (!op || ["cancelled", "completed"].includes(op.dto.phase))
      return { ok: true };
    op.abort.abort();
    clearTimeout(op.timer);
    if (op.pending) await op.pending.catch(() => {});
    if (op.commit) await op.commit.catch(() => {});
    if (op.dto.phase !== "completed") {
      if (op.candidate) await this.packages.abortCandidate(op.candidate);
      op.dto = { requestId, phase: "cancelled" };
    }
    return { ok: true };
  }
  async commit(
    input: RequestMap["extensions/commit"]["params"],
  ): Promise<ExtensionResult> {
    if (this.operations.get(input.requestId)?.dto.phase === "cancelled")
      conflict("Review закрыт; подготовьте новое подтверждение.");
    const op = this.operations.get(input.requestId),
      review = op?.dto.review;
    if (
      !op ||
      !review ||
      input.digest !== review.digest ||
      input.revision !== review.revision
    )
      conflict(
        "Подтверждение не соответствует точному review/digest/revision.",
      );
    const signature = JSON.stringify(input);
    if (op.commit) {
      if (op.confirmation !== signature)
        conflict("Операция уже получила другое подтверждение.");
      return op.commit;
    }
    if (op.dto.phase !== "review" || op.abort.signal.aborted)
      conflict("Review закрыт; подготовьте новое подтверждение.");
    if (review.incompatible) throw new Error(review.incompatible);
    if (
      review.kind !== "remove" &&
      review.trustRequired &&
      review.kind !== "install" &&
      !input.trust
    )
      throw new Error("Новое доверие не выдано; прежняя версия сохранена.");
    if (input.enable && !input.trust && review.kind === "install")
      throw new Error("Включение требует явного доверия.");
    op.confirmation = signature;
    op.dto.phase = "committing";
    clearTimeout(op.timer);
    op.commit = (async () => {
      const expected = {
        digest: op.selectedDigest ?? review.digest,
        revision: review.revision,
      };
      const options = {
        registryRevision: op.registryRevision,
        ...(input.trust
          ? { digest: review.digest, acknowledgeProcessAccess: true }
          : {}),
        ...(input.enable !== undefined ? { enabled: input.enable } : {}),
        signal: op.abort.signal,
      };
      let result: ExtensionResult;
      if (op.candidate)
        result = await this.packages.commitCandidate(op.candidate, options);
      else if (review.kind === "trust")
        result = await this.packages.trust(review.id, expected, options);
      else if (review.kind === "rollback")
        result = await this.packages.rollback(
          review.id,
          op.versionKey!,
          expected,
          options,
        );
      else result = await this.packages.remove(review.id, expected);
      op.dto = {
        requestId: input.requestId,
        phase: "completed",
        result: {
          id: result.id,
          restartRequired: result.restartRequired,
          deferred: result.deferred,
          ...(result.warning ? { warning: result.warning } : {}),
        },
      };
      return op.dto.result!;
    })().catch(async (error) => {
      if (op.candidate) await this.packages.abortCandidate(op.candidate);
      op.dto = {
        requestId: input.requestId,
        phase: op.abort.signal.aborted ? "cancelled" : "error",
        error: safeExtensionText(
          error instanceof Error ? error.message : "Операция не завершена.",
        ),
      };
      throw error;
    });
    return op.commit;
  }
  async setEnabled(
    input: RequestMap["extensions/setEnabled"]["params"],
  ): Promise<ExtensionResult> {
    if (input.id.startsWith("builtin.")) {
      if (!input.path) throw new Error("Сначала выберите проект.");
      const item = (await this.list(input.path)).items.find(
        (i) => i.id === input.id,
      );
      if (!item || item.digest !== input.digest || !item.settingsRoute)
        conflict();
      const state = await this.builtinRead(input.id, input.path),
        value = state.global as Record<string, Json>;
      if (state.globalRevision !== input.digest) conflict();
      await this.builtinSave({
        id: input.id,
        path: input.path,
        scope: "global",
        revision: state.globalRevision,
        value:
          input.id === "builtin.lsp"
            ? {
                ...value,
                mode: input.enabled
                  ? Object.keys((value.servers ?? {}) as object).length
                    ? "custom"
                    : "auto"
                  : "off",
              }
            : { ...value, enabled: input.enabled },
      });
      return { id: input.id, restartRequired: false, deferred: false };
    }
    if (
      input.enabled &&
      input.path &&
      (await this.list(input.path)).items.find((i) => i.id === input.id)
        ?.projectBlocked
    )
      throw new Error("Расширение запрещено для этого проекта.");
    const result = await this.packages.setEnabled(
      input.id,
      input.enabled,
      input,
    );
    return {
      id: result.id,
      restartRequired: result.restartRequired,
      deferred: result.deferred,
    };
  }
  async settings(
    input: RequestMap["extensions/settings/read"]["params"],
    save?: RequestMap["extensions/settings/save"]["params"],
  ): Promise<ExtensionSettings> {
    return withExtensionRegistry(async (registry) => {
      const row = registry.records.find(
          (r) => r.id === ExternalIdSchema.parse(input.id),
        ),
        version = row && selectedVersion(row);
      if (
        !row ||
        row.removedAt ||
        row.revision !== input.revision ||
        !version ||
        version.digest !== input.digest
      )
        conflict();
      const candidate = await inspectPackage(version.location);
      if (candidate.digest !== version.digest)
        conflict("Пакет изменён; настройки не сохранены.");
      const store = new ExtensionSettingsStore(candidate.manifest);
      return save
        ? store.save({
            revision: save.settingsRevision,
            values: save.values,
            secrets: save.secrets,
            clearSecrets: save.clearSecrets,
            reset: save.reset,
          })
        : store.read();
    });
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.operations.keys()].map((id) => this.cancel(id)),
    );
    this.operations.clear();
  }
}
