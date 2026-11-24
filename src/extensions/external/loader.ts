import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { loadProjectConfig } from "../../config/load.js";
import type { ExtensionFactory } from "../../extension-sdk/index.js";
import { SecretRedactor } from "../../security/redaction.js";
import { setThemeSource } from "../../themes/source.js";
import type { ChiselExtension } from "../contracts.js";
import { abortable, frozenClone } from "../lifecycle.js";
import {
  activationPlan,
  settlePackageActivation,
  withActivePackage,
} from "../packages/activation.js";
import { markRuntimeSnapshot } from "../packages/runtime-ownership.js";
import { acquireVersionUse, type PackageUseLease } from "../packages/use.js";
import { externalAllowed } from "../settings-contributions.js";
import { ExtensionSettingsStore } from "../settings-store.js";
import {
  adaptDefinition,
  createHostSdk,
  hostSettingsRevision,
} from "./adapter.js";
import { setApplicationResource } from "./application-resource.js";
import {
  markOptional,
  setOptionalClaim,
  setOptionalDiagnostic,
  setOptionalTransition,
} from "./optional.js";
import {
  canonicalPath,
  type InspectedPackage,
  inspectPackage,
  runtimeSnapshot,
} from "./package.js";
import {
  type ExtensionRecord,
  readExtensionRegistry,
  receiptMatches,
  runtimeRecord,
  selectedVersion,
} from "./registry.js";

export type ExternalState =
  | "disabled"
  | "not_trusted"
  | "incompatible"
  | "modified"
  | "invalid"
  | "loading"
  | "active"
  | "load_failed"
  | "activation_failed"
  | "cleanup_failed"
  | "pending_restart";
export interface ExtensionDiagnostic {
  id: string;
  name?: string;
  version?: string;
  apiVersion?: number;
  digest?: string;
  location?: string;
  enabled: boolean;
  trusted: boolean;
  compatible: boolean;
  state: ExternalState;
  reason?: string;
  workspaceRoot?: string;
  packageDigest?: string;
  settingsRevision?: number;
}
const redactor = new SecretRedactor();
export function safeExtensionText(text: string): string {
  return stripVTControlCharacters(
    redactor
      .text(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Untrusted metadata must not execute OSC/clipboard/hyperlink escapes.
      .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, ""),
  )
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 2000);
}
export async function inspectRecord(
  record: ExtensionRecord,
): Promise<{ diagnostic: ExtensionDiagnostic; candidate?: InspectedPackage }> {
  const base = {
    id: record.id,
    version: record.version,
    apiVersion: record.apiVersion,
    digest: record.digest.slice(0, 12),
    location: safeExtensionText(record.location),
    enabled: record.enabled,
    trusted: false,
    compatible: false,
  };
  try {
    const candidate = await inspectPackage(record.location),
      trusted = receiptMatches(record, candidate);
    return {
      candidate,
      diagnostic: {
        ...base,
        name: safeExtensionText(candidate.manifest.displayName),
        trusted,
        compatible: !candidate.incompatible,
        state: !trusted
          ? record.approvedAt
            ? "modified"
            : "not_trusted"
          : candidate.incompatible
            ? "incompatible"
            : !record.enabled
              ? "disabled"
              : "pending_restart",
        reason: !trusted
          ? record.approvedAt
            ? "Содержимое отличается от подтверждённого; код не загружен."
            : "Доверие к коду не подтверждено; код не загружен."
          : (candidate.incompatible ??
            (!record.enabled
              ? "Расширение выключено."
              : "Включено; runtime загружается при запуске рабочего сеанса.")),
      },
    };
  } catch {
    return {
      diagnostic: {
        ...base,
        state: "invalid",
        reason:
          "Пакет не прошёл проверку manifest, paths или limits; код не загружен.",
      },
    };
  }
}
// Canonical dynamic import, never a query-string cache bust. Factory runs once per approved identity.
interface ModuleEntry {
  promise: Promise<ChiselExtension>;
  demand: Set<AbortSignal>;
  abort: AbortController;
  started: boolean;
  settled: boolean;
}
const modules = new Map<string, ModuleEntry>();
const loadedSettings = new WeakMap<ChiselExtension, number>();
let operations = 0;
const waiters: Array<() => void> = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (operations >= 4)
    await new Promise<void>((resolve) => waiters.push(resolve));
  else operations++;
  try {
    return await work();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else operations--;
  }
}
async function loadModule(
  record: ExtensionRecord,
  candidate: InspectedPackage,
  signal: AbortSignal,
  lease: PackageUseLease,
): Promise<ChiselExtension> {
  const uiRevision =
    candidate.manifest.kind === "ui"
      ? (await new ExtensionSettingsStore(candidate.manifest).read()).revision
      : undefined;
  const key = JSON.stringify([
    record.id,
    canonicalPath(record.location),
    record.digest,
    ...(uiRevision === undefined ? [] : [uiRevision]),
  ]);
  if (uiRevision !== undefined) {
    for (const [oldKey, entry] of modules) {
      const identity = JSON.parse(oldKey) as unknown[];
      if (
        oldKey !== key &&
        identity.length === 4 &&
        identity[0] === record.id &&
        entry.settled
      )
        modules.delete(oldKey);
    }
  }
  let pending = modules.get(key);
  if (pending?.abort.signal.aborted && !pending.started) {
    modules.delete(key);
    pending = undefined;
  }
  if (!pending) {
    let cacheEntry!: ModuleEntry;
    const promise = Promise.resolve().then(() =>
      limited(async () => {
        // No remaining live workspace means no new snapshot/import/factory may begin.
        if (cacheEntry.abort.signal.aborted)
          throw new Error("Загрузка отменена до import.");
        const budget = () =>
          AbortSignal.any([
            cacheEntry.abort.signal,
            AbortSignal.timeout(10000),
          ]);
        const file = await runtimeSnapshot(candidate, budget(), () =>
          markRuntimeSnapshot(
            record.id,
            record.digest,
            candidate.bytes,
            lease.token,
          ),
        );
        if (cacheEntry.abort.signal.aborted)
          throw new Error("Загрузка отменена до import.");
        const sdk = createHostSdk(candidate.manifest);
        const settingsRevision = await hostSettingsRevision(sdk);
        cacheEntry.started = true;
        const module = await abortable(
          () => import(pathToFileURL(file).href),
          budget(),
        );
        if (typeof module.default !== "function")
          throw new Error("Отсутствует default factory.");
        const factory = module.default as ExtensionFactory;
        const definition = await abortable(
          () =>
            factory(
              Object.freeze({ sdk, manifest: frozenClone(candidate.manifest) }),
            ),
          budget(),
        );
        const adapted = adaptDefinition(definition, candidate.manifest, sdk);
        if (candidate.manifest.kind === "ui" && adapted.themes?.length)
          throw new Error(
            "Declare application themes in a standard extension.",
          );
        loadedSettings.set(adapted, settingsRevision);
        return adapted;
      }),
    );
    cacheEntry = {
      demand: new Set(),
      abort: new AbortController(),
      started: false,
      settled: false,
      promise,
    };
    promise.then(
      () => {
        cacheEntry.settled = true;
      },
      () => {
        cacheEntry.settled = true;
        if (!cacheEntry.started && modules.get(key) === cacheEntry)
          modules.delete(key);
      },
    );
    pending = cacheEntry;
    modules.set(key, pending);
  }
  const current = pending;
  current.demand.add(signal);
  const release = () => {
    current.demand.delete(signal);
    if (!current.demand.size && !current.settled) current.abort.abort();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    return await abortable(() => current.promise, signal);
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
}

/** One frozen user boot plan. Workspace policy only narrows it before import. */
export class ExternalExtensionLoader {
  private readonly applicationId = randomUUID();
  private readonly leases = new Map<string, Promise<PackageUseLease>>();
  private readonly failedCleanup = new Set<string>();
  private closed = false;
  private readonly diagnostics = new Map<string, ExtensionDiagnostic>();
  private readonly noticed = new Set<string>();
  private constructor(
    private readonly records: readonly ExtensionRecord[],
    private readonly notify: (message: string) => void,
    private readonly prepareOnly = false,
  ) {}
  static async create(
    notify: (message: string) => void = (message) =>
      process.stderr.write(message + "\n"),
    kind?: "standard" | "ui",
    onlyId?: string,
    prepareOnly = false,
  ): Promise<ExternalExtensionLoader> {
    try {
      const rows = (await readExtensionRegistry()).records;
      const records = rows.flatMap((row) => {
        const record = runtimeRecord(row);
        return record && (!onlyId || record.id === onlyId) ? [record] : [];
      });
      const selected = kind
        ? (
            await Promise.all(
              records.map(async (record) => {
                const row = rows.find(({ id }) => id === record.id)!;
                const extensionKind = selectedVersion(row)?.extensionKind;
                if (extensionKind)
                  return extensionKind === kind ? record : undefined;
                try {
                  const candidate = await inspectPackage(record.location);
                  return (candidate.manifest.kind ?? "standard") === kind
                    ? record
                    : undefined;
                } catch {
                  return kind === "standard" ? record : undefined;
                }
              }),
            )
          ).filter((record): record is ExtensionRecord => !!record)
        : records;
      return new ExternalExtensionLoader(
        frozenClone(selected),
        notify,
        prepareOnly,
      );
    } catch {
      const loader = new ExternalExtensionLoader([], notify);
      loader.notice(
        "registry",
        "Реестр расширений недоступен. Встроенные возможности сохранены; используйте --no-external-extensions.",
      );
      return loader;
    }
  }
  private notice(id: string, message: string) {
    if (this.noticed.has(id)) return;
    this.noticed.add(id);
    this.notify(safeExtensionText(message));
  }
  metadata(): readonly ExtensionDiagnostic[] {
    return frozenClone([...this.diagnostics.values()]);
  }
  private async use(
    record: ExtensionRecord,
    candidate: InspectedPackage,
  ): Promise<PackageUseLease> {
    if (this.closed) throw new Error("Application loader закрыт.");
    const key = JSON.stringify([
      record.id,
      record.digest,
      canonicalPath(record.location),
    ]);
    let lease = this.leases.get(key);
    if (!lease) {
      lease = acquireVersionUse(record, this.applicationId, candidate.bytes);
      this.leases.set(key, lease);
    }
    const result = await lease;
    if (this.closed) {
      await result.shutdown();
      throw new Error("Application loader закрыт.");
    }
    return result;
  }
  async dispose(cleanupConfirmed = true): Promise<void> {
    this.closed = true;
    const held = await Promise.allSettled(
      [...this.leases].map(async ([key, promise]) => ({
        id: (JSON.parse(key) as [string])[0],
        lease: await promise,
      })),
    );
    const results = await Promise.allSettled(
      held.flatMap((result) =>
        result.status === "fulfilled"
          ? [
              result.value.lease.shutdown(
                cleanupConfirmed && !this.failedCleanup.has(result.value.id),
              ),
            ]
          : [],
      ),
    );
    this.leases.clear();
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Use lease shutdown не подтверждён; bytes защищены recovery record.",
      );
  }
  definitions(
    required: readonly ChiselExtension[],
  ): readonly ChiselExtension[] {
    const ids = new Set(required.map((item) => item.id));
    return this.records.flatMap((initial) => {
      let record = initial;
      const active = new Map<string, ExtensionRecord>();
      const plans = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof activationPlan>>>
      >();
      if (ids.has(record.id)) {
        this.notice(
          record.id,
          `Расширение ${record.id}: id занят; внешний код не загружен.`,
        );
        return [];
      }
      ids.add(record.id);
      const loadedRoots = new Set<string>();
      let themeDefinition: ChiselExtension | undefined;
      let themeName = record.id;
      const report = (root: string, diagnostic: ExtensionDiagnostic) =>
        this.diagnostics.set(`${record.id}/${root}`, {
          ...diagnostic,
          workspaceRoot: root,
          packageDigest: active.get(root)?.digest ?? record.digest,
        });
      const wrapper: ChiselExtension = {
        id: record.id,
        activate: async (context) => {
          const selected = record;
          plans.delete(context.workspaceRoot);
          loadedRoots.delete(context.workspaceRoot);
          const config = await loadProjectConfig(context.workspaceRoot);
          if (!externalAllowed(selected.id, config)) {
            report(context.workspaceRoot, {
              id: selected.id,
              version: selected.version,
              apiVersion: 1,
              digest: selected.digest.slice(0, 12),
              enabled: false,
              trusted: !!selected.approvedAt,
              compatible: false,
              state: "disabled",
              reason: "Выключено user/project настройкой; код не загружен.",
            });
            return;
          }
          const plan = await activationPlan(selected);
          if (!plan) {
            report(context.workspaceRoot, {
              id: selected.id,
              version: selected.version,
              apiVersion: 1,
              digest: selected.digest.slice(0, 12),
              enabled: false,
              trusted: false,
              compatible: false,
              state: "disabled",
              reason: "Сохранённый выбор изменился до активации.",
            });
            return;
          }
          plans.set(context.workspaceRoot, plan);
          active.set(context.workspaceRoot, selected);
          const { diagnostic, candidate } = await inspectRecord(selected);
          report(context.workspaceRoot, diagnostic);
          if (!candidate || !diagnostic.trusted || !diagnostic.compatible) {
            this.notice(
              selected.id,
              `Расширение ${selected.id}: ${diagnostic.reason}`,
            );
            if (plan.lastWorking && plan.lastWorking !== plan.selected)
              throw new Error("Запрошенная версия недоступна.");
            return;
          }
          report(context.workspaceRoot, { ...diagnostic, state: "loading" });
          let definition: ChiselExtension;
          try {
            const lease = await this.use(selected, candidate);
            definition = await abortable(
              () => loadModule(selected, candidate, context.signal, lease),
              context.signal,
            );
            await lease.loaded();
            report(context.workspaceRoot, {
              ...diagnostic,
              state: "loading",
              settingsRevision: loadedSettings.get(definition),
            });
          } catch {
            report(context.workspaceRoot, {
              ...diagnostic,
              state: "load_failed",
              reason: "Ошибка import/factory после подтверждения доверия.",
            });
            this.failedCleanup.add(selected.id);
            this.notice(
              selected.id,
              `Расширение ${selected.id}: код не загружен; inspect/status покажет сведения.`,
            );
            throw new Error("Внешнее расширение не загрузилось.");
          }
          themeDefinition = definition;
          themeName = candidate.manifest.displayName;
          loadedRoots.add(context.workspaceRoot);
          if (candidate.manifest.kind === "ui") {
            const unsupported = () => {
              throw new Error(
                "UI extensions may register UI, chat views, owned tools and disposables only.",
              );
            };
            // Live UI has no background/service/runtime hooks to outlive its mount.
            await definition.activate(
              Object.freeze({
                ...context,
                automations: Object.freeze({ register: unsupported }),
                events: Object.freeze({
                  on: unsupported,
                  observe: unsupported,
                }),
                commands: Object.freeze({ register: unsupported }),
                services: Object.freeze({
                  provide: unsupported,
                  get: unsupported,
                  lookup: unsupported,
                }),
                guards: Object.freeze({
                  afterPrepare: unsupported,
                  beforeExecute: unsupported,
                }),
                contextProviders: Object.freeze({ register: unsupported }),
              }),
            );
          } else await definition.activate(context);
        },
      };
      setThemeSource(wrapper, () =>
        themeDefinition
          ? { themes: themeDefinition.themes ?? [], name: themeName }
          : undefined,
      );
      setOptionalClaim(wrapper, (root, claim) => {
        const selected = active.get(root);
        return selected
          ? withActivePackage(selected, claim)
          : Promise.resolve(undefined);
      });
      setOptionalTransition(wrapper, async (root, success, signal) => {
        if (this.prepareOnly) return success;
        const plan = plans.get(root);
        if (!plan || (success && !loadedRoots.has(root))) return success;
        const settled = await settlePackageActivation(plan, success, signal);
        if (settled && !success) record = settled;
        return !!settled;
      });
      setApplicationResource(wrapper, this);
      setOptionalDiagnostic(wrapper, (root) =>
        this.diagnostics.get(`${record.id}/${root}`),
      );
      return [
        markOptional(wrapper, (state, root) => {
          if (state === "cleanup_failed") this.failedCleanup.add(record.id);
          if (state === "activation_failed") loadedRoots.delete(root);
          if (state === "disposed") {
            this.diagnostics.delete(`${record.id}/${root}`);
            loadedRoots.delete(root);
            return;
          }
          const prior = this.diagnostics.get(`${record.id}/${root}`);
          if (
            !prior ||
            prior.state === "disabled" ||
            (state === "active" && !loadedRoots.has(root))
          )
            return;
          if (prior.state === "load_failed" && state === "activation_failed")
            return;
          report(root, {
            ...prior,
            state,
            ...(state !== "active"
              ? {
                  reason:
                    state === "cleanup_failed"
                      ? "Регистрации сняты; очистка ресурсов не подтверждена."
                      : "Активация отменена; собственные регистрации сняты.",
                }
              : {}),
          });
          if (state !== "active")
            this.notice(
              record.id,
              `Расширение ${record.id}: ${state === "cleanup_failed" ? "ошибка очистки" : "ошибка активации"}; встроенные возможности доступны.`,
            );
        }),
      ];
    });
  }
}
