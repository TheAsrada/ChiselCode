import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { cancelled } from "../../runtime/errors.js";
import { replaceSessionFile } from "../../sessions/atomic.js";
import { safeExtensionText } from "../external/loader.js";
import { EXTERNAL_LIMITS, ExternalIdSchema } from "../external/manifest.js";
import {
  canonicalPath,
  type InspectedPackage,
  inspectPackage,
} from "../external/package.js";
import {
  type ExtensionRegistry,
  type InstalledVersion,
  type ManagedRecord,
  readExtensionRegistry,
  receiptMatches,
  runtimeRecord,
  selectedVersion,
  withExtensionRegistry,
} from "../external/registry.js";
import { frozenClone } from "../lifecycle.js";
import { PackageManagementError } from "./errors.js";
import {
  CAPTURE_LIMITS,
  type CaptureProgress,
  captureSource,
} from "./ingest.js";
import {
  type PackageJournal,
  type PackageOutcome,
  readJournal,
  writeJournal,
} from "./journal.js";
import {
  managedLocation,
  OwnershipSchema,
  ownershipPath,
  verifyOwnedVersion,
  writeOwnership,
} from "./ownership.js";
import { currentProcessIdentity, identityState } from "./process-identity.js";
import { checkPackageQuota } from "./quota.js";
import { deleteOwnedRuntime } from "./runtime-ownership.js";
import { atomicPackageJson, boundedJson, packageDirectory } from "./storage.js";
import { releaseStoppedUses, type VersionUse, versionUses } from "./use.js";

export interface PackagePreview {
  operationId: string;
  kind: "install" | "update";
  id: string;
  name: string;
  version: string;
  digest: string;
  location: string;
  bytes: number;
  files: number;
  sourceKind: "directory" | "zip";
  oldVersion?: string;
  oldDigest?: string;
  expectedRevision?: number;
  incompatible?: string;
  requestedEnabled: boolean;
  trustRequired: boolean;
  restartRequired: true;
  downgrade: boolean;
  description: string;
  entry: string;
  compatibility: string;
  contents: readonly { path: string; bytes: number; digest: string }[];
}
/** The preview is data. Only this service's private object is commit authority. */
export interface PreparedPackage {
  readonly preview: Readonly<PackagePreview>;
}
export interface PrepareOptions {
  signal?: AbortSignal;
  progress?: (value: CaptureProgress) => void;
  allowDowngrade?: boolean;
}
export interface CommitOptions {
  registryRevision?: number;
  digest?: string;
  acknowledgeProcessAccess?: boolean;
  enabled?: boolean;
  signal?: AbortSignal;
}
export interface PackageExpected {
  digest: string;
  revision: number;
}
export interface PackageStatus {
  id: string;
  revision: number;
  name: string;
  selected?: InstalledVersion;
  enabled: boolean;
  removed: boolean;
  trusted: boolean;
  compatible: boolean;
  state: string;
  reason?: string;
  versions: readonly InstalledVersion[];
  uses: readonly Pick<
    VersionUse,
    "applicationId" | "digest" | "phase" | "confidence"
  >[];
  restartRequired: boolean;
}
export type PackageFaultPoint =
  | "reserved"
  | "captured"
  | "ready"
  | "publishing"
  | "published"
  | "registry_committed"
  | "committed"
  | "cleanup";
interface ServiceOptions {
  fault?: (point: PackageFaultPoint, operationId: string) => Promise<void>;
}
const reservation = 128 * 1024 * 1024,
  expiry = 30 * 60_000;
async function assertJournalCapacity(): Promise<void> {
  if (
    (await readdir(await packageDirectory(".management", "operations")))
      .length >= 1024
  )
    throw new PackageManagementError(
      "PACKAGE_QUOTA",
      "Лимит истории 1024 операций исчерпан; старые receipts сохраняются, новая операция не принята.",
    );
}
const StagingOwner = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
});
function older(a: string, b: string): boolean {
  const aa = a.split("-")[0]!.split(".").map(Number),
    bb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! < bb[i]!;
  return !a.includes("-") ? false : !b.includes("-") || a < b;
}
function conflict(
  message = "Пакет изменился после preview; повторите операцию.",
): never {
  throw new PackageManagementError("PACKAGE_CONFLICT", message);
}
function assertExpected(
  row: ManagedRecord | undefined,
  expected: PackageJournal["expected"],
): void {
  if (
    expected
      ? !row ||
        row.revision !== expected.revision ||
        row.selected !== expected.selected ||
        row.enabled !== expected.enabled
      : !!row && !row.removedAt
  )
    conflict();
}
function assertCurrent(
  row: ManagedRecord | undefined,
  expected: PackageExpected,
): asserts row is ManagedRecord {
  if (
    !row ||
    row.removedAt ||
    row.revision !== expected.revision ||
    selectedVersion(row)?.digest !== expected.digest
  )
    conflict();
}
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function staging(id: string): Promise<string> {
  z.uuid().parse(id);
  return join(await packageDirectory(".staging"), id);
}
async function removeStaging(
  id: string,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const path = await staging(id);
  if (!(await present(path))) return;
  const info = await lstat(path),
    owner = StagingOwner.parse(
      await boundedJson(join(path, "owner.json"), 1024),
    );
  if (!info.isDirectory() || info.isSymbolicLink() || owner.operationId !== id)
    throw new PackageManagementError(
      "PACKAGE_RECOVERY_REQUIRED",
      "Staging ownership не подтверждён; файлы сохранены.",
    );
  await assertOwned();
  await rm(path, { recursive: true });
}

export class PackageManagementService {
  readonly #prepared = new WeakMap<PreparedPackage, string>();
  readonly #options: ServiceOptions;
  constructor(options: ServiceOptions = {}) {
    this.#options = options;
  }
  async #fault(point: PackageFaultPoint, id: string): Promise<void> {
    await this.#options.fault?.(point, id);
  }
  prepareInstall(
    source: string,
    options: PrepareOptions = {},
  ): Promise<PreparedPackage> {
    return this.#prepare("install", source, undefined, options);
  }
  prepareUpdate(
    id: string,
    source: string,
    options: PrepareOptions = {},
  ): Promise<PreparedPackage> {
    ExternalIdSchema.parse(id);
    return this.#prepare("update", source, id, options);
  }
  async #prepare(
    kind: "install" | "update",
    source: string,
    id: string | undefined,
    options: PrepareOptions,
  ): Promise<PreparedPackage> {
    const capturedSource = resolve(source),
      operationId = randomUUID(),
      identity = await currentProcessIdentity(),
      now = Date.now();
    const controller = new AbortController(),
      abort = () => controller.abort(options.signal?.reason),
      timer = setTimeout(
        () => controller.abort(new Error("Capture/verify превысил 60 секунд.")),
        CAPTURE_LIMITS.budget,
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let record: PackageJournal = {
      schemaVersion: 1,
      operationId,
      kind,
      phase: "preparing",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiry).toISOString(),
      ...identity,
      reservedBytes: reservation,
      allowDowngrade: !!options.allowDowngrade,
    };
    try {
      await withExtensionRegistry(async (state, assertOwned) => {
        cancelled(controller.signal);
        await assertJournalCapacity();
        if (id) {
          const row = state.records.find((x) => x.id === id);
          if (!row || row.removedAt)
            conflict("Расширение не установлено; используйте install.");
          record.expected = {
            id,
            revision: row.revision,
            selected: row.selected,
            enabled: row.enabled,
          };
        }
        await checkPackageQuota(reservation);
        await writeJournal(record, assertOwned);
        const path = await staging(operationId);
        await assertOwned();
        await mkdir(path, { mode: 0o700 });
        await atomicPackageJson(
          join(path, "owner.json"),
          { schemaVersion: 1, operationId },
          assertOwned,
        );
      });
      await this.#fault("reserved", operationId);
      const path = await staging(operationId),
        captured = await captureSource(
          capturedSource,
          join(path, "package"),
          join(path, "source.zip"),
          controller.signal,
          options.progress,
        );
      await this.#fault("captured", operationId);
      cancelled(controller.signal);
      options.progress?.({
        phase: "verify",
        bytes: captured.bytes,
        files: captured.files,
      });
      const candidate = await inspectPackage(
        join(path, "package"),
        controller.signal,
      );
      cancelled(controller.signal);
      if (id && candidate.manifest.id !== id)
        conflict("Update должен содержать тот же id расширения.");
      const location = await managedLocation(
        candidate.manifest.id,
        candidate.digest,
      );
      const version: InstalledVersion = {
        key: candidate.digest,
        id: candidate.manifest.id,
        version: candidate.manifest.version,
        apiVersion: 1,
        entry: candidate.manifest.entry,
        location,
        digest: candidate.digest,
        kind: "managed",
        bytes: candidate.bytes,
        files: candidate.files,
        installedAt: new Date().toISOString(),
        operationId,
        name: safeExtensionText(candidate.manifest.displayName).slice(0, 120),
        source: safeExtensionText(captured.location),
      };
      const preview = await withExtensionRegistry(
        async (state, assertOwned) => {
          const row = state.records.find((x) => x.id === version.id),
            prior = row && selectedVersion(row);
          if (kind === "install" && row && !row.removedAt)
            conflict(
              "Этот id уже установлен. Используйте update с явным источником.",
            );
          assertExpected(row, record.expected);
          if (
            row &&
            row.versions.length >= 64 &&
            !row.versions.some((v) => v.key === version.key)
          )
            throw new PackageManagementError(
              "PACKAGE_QUOTA",
              "Лимит защищённых версий исчерпан; unknown/used версии не вытесняются.",
            );
          if (!row && state.records.length >= EXTERNAL_LIMITS.packages)
            throw new PackageManagementError(
              "PACKAGE_QUOTA",
              "Можно подключить не более 32 внешних пакетов.",
            );
          if (kind === "install" && row)
            record.expected = {
              id: row.id,
              revision: row.revision,
              selected: row.selected,
              enabled: row.enabled,
            };
          record = {
            ...record,
            phase: "ready",
            candidate: version,
            sourceKind: captured.kind,
            ...(candidate.incompatible
              ? { incompatible: candidate.incompatible }
              : {}),
          };
          await writeJournal(record, assertOwned);
          return frozenClone({
            operationId,
            kind,
            id: version.id,
            name: version.name!,
            version: version.version,
            digest: version.digest,
            location: safeExtensionText(location),
            bytes: version.bytes,
            files: version.files,
            ...(row ? { expectedRevision: row.revision } : {}),
            sourceKind: captured.kind,
            ...(prior
              ? {
                  oldVersion: prior.version,
                  oldDigest: prior.digest,
                  expectedRevision: row!.revision,
                }
              : {}),
            ...(candidate.incompatible
              ? { incompatible: candidate.incompatible }
              : {}),
            requestedEnabled: kind === "update" && !!row?.enabled,
            trustRequired: true,
            restartRequired: true as const,
            downgrade: !!prior && older(version.version, prior.version),
            description: safeExtensionText(
              candidate.manifest.description ?? "",
            ),
            entry: candidate.manifest.entry,
            compatibility: candidate.manifest.chiselVersion ?? "API v1",
            contents: candidate.contents.map((f) => ({
              ...f,
              path: safeExtensionText(f.path),
            })),
          });
        },
      );
      await this.#fault("ready", operationId);
      const handle = Object.freeze({ preview });
      this.#prepared.set(handle, operationId);
      return handle;
    } catch (error) {
      try {
        await this.#abortId(operationId);
      } catch {
        throw new PackageManagementError(
          "PACKAGE_RECOVERY_REQUIRED",
          "Подготовка не завершена, cleanup staging не подтверждён. Selected prior сохранён; выполните extensions recover.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  async abortCandidate(candidate: PreparedPackage): Promise<void> {
    await this.#abortId(this.#identity(candidate));
  }
  #identity(candidate: PreparedPackage): string {
    const id = this.#prepared.get(candidate);
    if (!id)
      throw new PackageManagementError(
        "PACKAGE_DENIED",
        "Preview не является правом commit; подготовьте candidate через этот сервис.",
      );
    return id;
  }
  async #abortId(id: string): Promise<void> {
    await withExtensionRegistry(async (_state, assertOwned) => {
      let record: PackageJournal;
      try {
        record = await readJournal(id);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      if (record.phase === "committed") return;
      if (record.phase === "publishing" || record.phase === "recovery_required")
        return;
      await removeStaging(id, assertOwned);
      await writeJournal(
        { ...record, phase: "aborted", reservedBytes: 0 },
        assertOwned,
      );
    });
  }
  async commitCandidate(
    candidate: PreparedPackage,
    options: CommitOptions = {},
  ): Promise<Readonly<PackageOutcome>> {
    const id = this.#identity(candidate);
    return withExtensionRegistry(async (state, assertOwned, save) => {
      let record = await readJournal(id);
      if (record.phase === "committed" && record.result)
        return frozenClone(record.result);
      if (
        options.registryRevision !== undefined &&
        options.registryRevision !== state.revision
      )
        conflict();
      if (record.phase !== "ready" || !record.candidate)
        throw new PackageManagementError(
          "PACKAGE_RECOVERY_REQUIRED",
          "Candidate не готов к commit; проверьте recovery.",
        );
      cancelled(options.signal);
      if (Date.parse(record.expiresAt) < Date.now())
        throw new PackageManagementError(
          "PACKAGE_EXPIRED",
          "Preview истёк; подготовьте пакет заново.",
        );
      const version = record.candidate,
        prior = state.records.find((x) => x.id === version.id);
      assertExpected(prior, record.expected);
      if (record.incompatible)
        throw new PackageManagementError(
          "INVALID_PACKAGE",
          record.incompatible,
        );
      if (candidate.preview.downgrade && !record.allowDowngrade)
        throw new PackageManagementError(
          "PACKAGE_DENIED",
          "Это downgrade; нужен явный --allow-downgrade или rollback.",
        );
      const trust =
        options.digest === version.digest &&
        options.acknowledgeProcessAccess === true;
      if (options.digest !== undefined && !trust)
        throw new PackageManagementError(
          "PACKAGE_DENIED",
          "Доверие требует точного digest candidate и подтверждения доступа процесса.",
        );
      const enabled =
        options.enabled ??
        (record.kind === "update" ? !!prior?.enabled : false);
      if ((record.kind === "update" || enabled) && !trust)
        throw new PackageManagementError(
          "PACKAGE_DENIED",
          "Новые bytes update/enable требуют отдельного точного доверия. Выбранная версия сохранена.",
        );
      const staged = join(await staging(id), "package"),
        fresh = await inspectPackage(staged, options.signal);
      if (fresh.digest !== version.digest || fresh.manifest.id !== version.id)
        throw new PackageManagementError(
          "INVALID_PACKAGE",
          "Staging изменился после preview; прежняя версия сохранена.",
        );
      record = { ...record, phase: "publishing" };
      await writeJournal(record, assertOwned);
      let published = { ...version };
      try {
        await this.#fault("publishing", id);
        if (await present(version.location)) {
          const owner = OwnershipSchema.parse(
            await boundedJson(
              await ownershipPath(version.id, version.digest),
              2048,
            ),
          );
          published = { ...version, operationId: owner.operationId };
          await verifyOwnedVersion(published);
        } else {
          await writeOwnership(version, assertOwned);
          await assertOwned();
          await replaceSessionFile(staged, version.location, assertOwned);
          await verifyOwnedVersion(version);
        }
        await this.#fault("published", id);
        cancelled(options.signal);
        if (trust) published.approvedAt = new Date().toISOString();
        const row: ManagedRecord = {
          id: version.id,
          revision: (prior?.revision ?? 0) + 1,
          selected: published.key,
          enabled,
          lastOperationId: id,
          versions: [
            ...(prior?.versions.filter((x) => x.key !== published.key) ?? []),
            published,
          ],
        };
        state.records = [...state.records.filter((x) => x.id !== row.id), row];
        state.revision++;
        state.commits.push({
          operationId: id,
          id: row.id,
          digest: published.digest,
          enabled,
          trusted: !!published.approvedAt,
          location: published.location,
          bytes: published.bytes,
        });
        await save();
        const outcome: PackageOutcome = {
          operationId: id,
          id: row.id,
          outcome: "committed",
          digest: published.digest,
          enabled,
          trusted: !!published.approvedAt,
          restartRequired: true,
          deferred: false,
          retainedBytes: published.bytes,
          location: safeExtensionText(published.location),
        };
        record = { ...record, result: outcome };
        // After save, failures/cancellation describe a committed operation, never a failed installation.
        try {
          await this.#fault("registry_committed", id);
          await writeJournal({ ...record, phase: "committed" }, assertOwned);
          await this.#fault("committed", id);
          await this.#fault("cleanup", id);
          await removeStaging(id, assertOwned);
          record = { ...record, phase: "committed", reservedBytes: 0 };
          await writeJournal(record, assertOwned);
          await this.#prune(state, row, assertOwned);
          await save();
          return frozenClone(outcome);
        } catch {
          const partial = {
            ...outcome,
            deferred: true,
            warning:
              "Установка committed; cleanup не завершён. Выполните extensions recover.",
          };
          await writeJournal(
            { ...record, phase: "committed", result: partial },
            assertOwned,
          ).catch(() => {});
          return frozenClone(partial);
        }
      } catch (error) {
        await writeJournal(
          {
            ...record,
            phase: "recovery_required",
            reason: "Publication не завершён; selected prior сохранён.",
          },
          assertOwned,
        ).catch(() => {});
        throw error;
      }
    });
  }
  async #prune(
    state: ExtensionRegistry,
    row: ManagedRecord,
    assertOwned: () => Promise<void>,
  ): Promise<void> {
    const inactive = row.versions
      .filter((v) => v.key !== row.selected && v.kind === "managed")
      .sort((a, b) => b.installedAt.localeCompare(a.installedAt));
    for (const version of inactive.slice(4)) {
      if (await this.#deleteVersion(version, assertOwned))
        row.versions = row.versions.filter((v) => v.key !== version.key);
    }
    state.records = state.records.map((v) => (v.id === row.id ? row : v));
  }
  async #deleteVersion(
    version: InstalledVersion,
    assertOwned: () => Promise<void>,
  ): Promise<boolean> {
    if (version.kind !== "managed") return false;
    const uses = await versionUses(version.id, version.digest);
    if (uses.some((use) => use.confidence !== "dead")) return false;
    if (!(await present(version.location))) {
      if (
        canonicalPath(version.location) !==
        canonicalPath(await managedLocation(version.id, version.digest))
      )
        throw new Error("Managed location не подтверждён.");
      const marker = await ownershipPath(version.id, version.digest);
      if (await present(marker)) {
        const owner = OwnershipSchema.parse(await boundedJson(marker, 2048));
        if (
          owner.id !== version.id ||
          owner.digest !== version.digest ||
          owner.operationId !== version.operationId
        )
          throw new Error("Missing version ownership не подтверждён.");
        await assertOwned();
        await rm(marker);
      }
      await deleteOwnedRuntime(version, assertOwned);
      return true;
    }
    await verifyOwnedVersion(version);
    await deleteOwnedRuntime(version, assertOwned);
    await assertOwned();
    await rm(version.location, { recursive: true });
    await assertOwned();
    await rm(await ownershipPath(version.id, version.digest));
    return true;
  }
  async list(): Promise<readonly PackageStatus[]> {
    const registry = await readExtensionRegistry(),
      uses = await versionUses();
    return Promise.all(
      registry.records.map(async (row) => {
        const version = selectedVersion(row),
          ownUses = uses.filter(
            (use) => use.id === row.id && use.confidence !== "dead",
          );
        let trusted = false,
          compatible = false,
          state = row.removedAt ? "removed" : "invalid",
          reason: string | undefined;
        if (version && !row.removedAt) {
          try {
            const candidate = await inspectPackage(version.location);
            trusted = receiptMatches(runtimeRecord(row)!, candidate);
            compatible = !candidate.incompatible;
            state = !compatible
              ? "incompatible"
              : !trusted
                ? version.approvedAt
                  ? "modified"
                  : "not_trusted"
                : !row.enabled
                  ? "disabled"
                  : "pending_restart";
            reason = candidate.incompatible;
          } catch {
            reason = "Пакет недоступен или повреждён; код не выполнялся.";
          }
        }
        return frozenClone({
          id: row.id,
          revision: row.revision,
          name: version?.name ?? row.id,
          ...(version
            ? {
                selected: {
                  ...version,
                  location: safeExtensionText(version.location),
                  source: version.source && safeExtensionText(version.source),
                },
              }
            : {}),
          enabled: row.enabled,
          removed: !!row.removedAt,
          trusted,
          compatible,
          state,
          ...(reason ? { reason } : {}),
          versions: row.versions.map((v) => ({
            ...v,
            location: safeExtensionText(v.location),
            source: v.source && safeExtensionText(v.source),
          })),
          uses: ownUses.map(({ applicationId, digest, phase, confidence }) => ({
            applicationId,
            digest,
            phase,
            confidence,
          })),
          restartRequired: ownUses.length
            ? ownUses.some(
                (use) =>
                  !row.enabled ||
                  !!row.removedAt ||
                  !version ||
                  use.digest !== version.digest ||
                  canonicalPath(use.location) !==
                    canonicalPath(version.location) ||
                  use.phase === "recovery" ||
                  use.confidence === "unknown",
              )
            : row.enabled,
        });
      }),
    );
  }
  async status(id: string): Promise<PackageStatus> {
    ExternalIdSchema.parse(id);
    const row = (await this.list()).find((x) => x.id === id);
    if (!row) conflict("Пакет не найден.");
    return row;
  }
  async setEnabled(
    id: string,
    enabled: boolean,
    expected: PackageExpected,
  ): Promise<Readonly<PackageOutcome>> {
    ExternalIdSchema.parse(id);
    return withExtensionRegistry(async (state, _assertOwned, save) => {
      const row = state.records.find((x) => x.id === id);
      assertCurrent(row, expected);
      const version = selectedVersion(row)!;
      if (enabled) {
        const candidate = await inspectPackage(version.location);
        if (
          candidate.incompatible ||
          !receiptMatches(runtimeRecord(row)!, candidate)
        )
          throw new PackageManagementError(
            "PACKAGE_DENIED",
            "Для enable нужны неизменный совместимый пакет и точный trust receipt; выполните approve.",
          );
      }
      const changed = row.enabled !== enabled;
      if (changed) {
        row.enabled = enabled;
        row.revision++;
        state.revision++;
        await save();
      }
      return frozenClone({
        operationId: randomUUID(),
        id,
        outcome: changed ? "committed" : "no-op",
        digest: version.digest,
        enabled,
        trusted: !!version.approvedAt,
        restartRequired: changed,
        deferred: false,
        retainedBytes: version.bytes,
        location: safeExtensionText(version.location),
      });
    });
  }
  /** Atomic exact-content trust for an already installed package. */
  async trust(
    id: string,
    expected: PackageExpected,
    options: CommitOptions,
  ): Promise<Readonly<PackageOutcome>> {
    ExternalIdSchema.parse(id);
    return withExtensionRegistry(async (state, _assertOwned, save) => {
      const row = state.records.find((x) => x.id === id);
      assertCurrent(row, expected);
      const version = selectedVersion(row)!,
        candidate = await inspectPackage(version.location, options.signal);
      if (
        candidate.digest !== expected.digest ||
        candidate.incompatible ||
        options.digest !== expected.digest ||
        !options.acknowledgeProcessAccess
      )
        throw new PackageManagementError(
          "PACKAGE_DENIED",
          "Доверие требует неизменный совместимый пакет и явное подтверждение точного digest.",
        );
      cancelled(options.signal);
      version.approvedAt = new Date().toISOString();
      row.enabled = options.enabled ?? row.enabled;
      row.revision++;
      state.revision++;
      await save();
      return frozenClone({
        operationId: randomUUID(),
        id,
        outcome: "committed",
        digest: version.digest,
        enabled: row.enabled,
        trusted: true,
        restartRequired: true,
        deferred: false,
        retainedBytes: version.bytes,
        location: safeExtensionText(version.location),
      });
    });
  }
  async rollback(
    id: string,
    versionKey: string,
    expected: PackageExpected,
    options: CommitOptions = {},
  ): Promise<Readonly<PackageOutcome>> {
    ExternalIdSchema.parse(id);
    return withExtensionRegistry(async (state, _assertOwned, save) => {
      cancelled(options.signal);
      const row = state.records.find((x) => x.id === id);
      assertCurrent(row, expected);
      const matches = row.versions.filter(
        (v) => v.key === versionKey || v.digest === versionKey,
      );
      if (matches.length > 1)
        conflict(
          "Digest соответствует нескольким locations; укажите точный key из versions.",
        );
      const version = matches[0];
      if (!version) conflict("Сохранённая версия не найдена.");
      const candidate = await inspectPackage(version.location);
      let trustChanged = false;
      if (candidate.incompatible || candidate.digest !== version.digest)
        throw new PackageManagementError(
          "INVALID_PACKAGE",
          "Rollback версия недоступна, изменена или несовместима.",
        );
      if (
        !receiptMatches(
          {
            id: version.id,
            version: version.version,
            apiVersion: 1,
            entry: version.entry,
            location: version.location,
            digest: version.digest,
            approvedAt: version.approvedAt,
            enabled: row.enabled,
          },
          candidate,
        )
      ) {
        if (
          options.digest !== version.digest ||
          !options.acknowledgeProcessAccess
        )
          throw new PackageManagementError(
            "PACKAGE_DENIED",
            "У версии нет точного trust receipt; подтвердите digest и доступ процесса.",
          );
        version.approvedAt = new Date().toISOString();
        trustChanged = true;
      }
      const changed = row.selected !== version.key || trustChanged;
      if (changed) {
        row.selected = version.key;
        row.revision++;
        state.revision++;
        await save();
      }
      return frozenClone({
        operationId: randomUUID(),
        id,
        outcome: changed ? "committed" : "no-op",
        digest: version.digest,
        enabled: row.enabled,
        trusted: true,
        restartRequired: changed,
        deferred: false,
        retainedBytes: version.bytes,
        location: safeExtensionText(version.location),
      });
    });
  }
  async remove(
    id: string,
    expected: PackageExpected,
  ): Promise<Readonly<PackageOutcome>> {
    ExternalIdSchema.parse(id);
    return withExtensionRegistry(async (state, assertOwned, save) => {
      const row = state.records.find((x) => x.id === id);
      if (row?.removedAt)
        return frozenClone({
          operationId: randomUUID(),
          id,
          outcome: "no-op",
          enabled: false,
          trusted: false,
          restartRequired: true,
          deferred: row.versions.some((v) => v.kind === "managed"),
          retainedBytes: row.versions.reduce((n, v) => n + v.bytes, 0),
          warning:
            "Подключение уже удалено; retained bytes проверяются через recover.",
        });
      assertCurrent(row, expected);
      const version = selectedVersion(row)!;
      row.removedAt = new Date().toISOString();
      row.enabled = false;
      row.revision++;
      state.revision++;
      await save();
      let deferred = false,
        warning: string | undefined;
      for (const item of [...row.versions]) {
        if (item.kind === "legacy") {
          warning =
            "Подключение удалено; вручную подготовленная папка сохранена: " +
            safeExtensionText(item.location);
          continue;
        }
        try {
          if (await this.#deleteVersion(item, assertOwned))
            row.versions = row.versions.filter((v) => v.key !== item.key);
          else deferred = true;
        } catch {
          deferred = true;
          warning =
            "Подключение удалено; use/ownership/cleanup не подтверждён, bytes сохранены.";
        }
      }
      if (!row.versions.some((v) => v.key === row.selected))
        delete row.selected;
      await save();
      return frozenClone({
        operationId: randomUUID(),
        id,
        outcome: "committed",
        digest: version.digest,
        enabled: false,
        trusted: !!version.approvedAt,
        restartRequired: true,
        deferred,
        retainedBytes: row.versions.reduce((n, v) => n + v.bytes, 0),
        ...(warning ? { warning } : {}),
      });
    });
  }
  async recover(): Promise<
    readonly { operationId: string; state: string; reason?: string }[]
  > {
    return withExtensionRegistry(async (state, assertOwned, save) => {
      const result: { operationId: string; state: string; reason?: string }[] =
          [],
        directory = await packageDirectory(".management", "operations");
      for (const file of (await readdir(directory)).slice(0, 1024)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) {
          result.push({ operationId: "unknown", state: "recovery_required" });
          continue;
        }
        const id = file.slice(0, -5);
        let record: PackageJournal;
        try {
          record = await readJournal(id);
        } catch {
          result.push({
            operationId: id,
            state: "recovery_required",
            reason: "Journal повреждён; данные сохранены.",
          });
          continue;
        }
        const committedReceipt = state.commits.find(
            (receipt) => receipt.operationId === id,
          ),
          committedRow = state.records.find(
            (row) => row.lastOperationId === id,
          ),
          committed = !!committedReceipt || !!committedRow;
        const confidence = await identityState(record);
        if (
          !committed &&
          record.phase !== "committed" &&
          record.phase !== "aborted" &&
          record.phase !== "recovery_required" &&
          confidence !== "dead" &&
          Date.parse(record.expiresAt) >= Date.now()
        ) {
          result.push({
            operationId: id,
            state: record.phase,
            ...(confidence === "unknown"
              ? { reason: "Владелец неизвестен; staging сохранён." }
              : {}),
          });
          continue;
        }
        try {
          await removeStaging(id, assertOwned);
          const orphan = record.candidate;
          if (
            !committed &&
            record.phase !== "committed" &&
            orphan &&
            !state.records.some((row) =>
              row.versions.some(
                (v) =>
                  v.location === orphan.location && v.digest === orphan.digest,
              ),
            )
          ) {
            if (
              (await present(orphan.location)) &&
              !(await this.#deleteVersion(orphan, assertOwned))
            )
              throw new Error(
                "Published candidate имеет live/unknown use; bytes сохранены.",
              );
          }
          const phase =
            committed || record.phase === "committed" ? "committed" : "aborted";
          const version = committedRow && selectedVersion(committedRow);
          const receipt =
            committedReceipt ??
            (version
              ? {
                  id: version.id,
                  digest: version.digest,
                  enabled: committedRow!.enabled,
                  trusted: !!version.approvedAt,
                  bytes: version.bytes,
                  location: version.location,
                }
              : undefined);
          const outcome =
            record.result ??
            (receipt
              ? {
                  operationId: id,
                  id: receipt.id,
                  outcome: "committed" as const,
                  digest: receipt.digest,
                  enabled: receipt.enabled,
                  trusted: receipt.trusted,
                  restartRequired: true,
                  deferred: false,
                  retainedBytes: receipt.bytes,
                  location: safeExtensionText(receipt.location),
                }
              : undefined);
          await writeJournal(
            {
              ...record,
              phase,
              reservedBytes: 0,
              ...(outcome ? { result: outcome } : {}),
            },
            assertOwned,
          );
          result.push({ operationId: id, state: phase });
        } catch {
          result.push({
            operationId: id,
            state: "recovery_required",
            reason: "Cleanup ownership не подтверждён; данные сохранены.",
          });
        }
      }
      await releaseStoppedUses(assertOwned);
      for (const row of state.records) {
        if (row.removedAt) {
          for (const version of [...row.versions]) {
            try {
              if (await this.#deleteVersion(version, assertOwned))
                row.versions = row.versions.filter(
                  (v) => v.key !== version.key,
                );
            } catch {
              /* Unknown bytes remain fenced. */
            }
          }
          if (!row.versions.some((v) => v.key === row.selected))
            delete row.selected;
        } else await this.#prune(state, row, assertOwned);
      }
      await save();
      return frozenClone(result);
    });
  }
  async inspectSource(
    source: string,
    options: PrepareOptions = {},
  ): Promise<Readonly<InspectedPackage>> {
    // Inspection deliberately does not capture current registry selection or grant commit authority.
    const capturedSource = resolve(source),
      id = randomUUID(),
      root = await staging(id),
      identity = await currentProcessIdentity(),
      controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason),
      timer = setTimeout(
        () => controller.abort(new Error("Проверка превысила 60 секунд.")),
        CAPTURE_LIMITS.budget,
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      await withExtensionRegistry(async (_state, assertOwned) => {
        await assertJournalCapacity();
        await checkPackageQuota(reservation);
        await writeJournal(
          {
            schemaVersion: 1,
            operationId: id,
            kind: "install",
            phase: "preparing",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + expiry).toISOString(),
            ...identity,
            reservedBytes: reservation,
          },
          assertOwned,
        );
        await mkdir(root, { mode: 0o700 });
        await atomicPackageJson(
          join(root, "owner.json"),
          { schemaVersion: 1, operationId: id },
          assertOwned,
        );
      });
      const captured = await captureSource(
          capturedSource,
          join(root, "package"),
          join(root, "source.zip"),
          controller.signal,
          options.progress,
        ),
        candidate = await inspectPackage(
          join(root, "package"),
          controller.signal,
        );
      return frozenClone({
        ...candidate,
        location: safeExtensionText(captured.location),
        manifest: {
          ...candidate.manifest,
          displayName: safeExtensionText(candidate.manifest.displayName),
          ...(candidate.manifest.description
            ? { description: safeExtensionText(candidate.manifest.description) }
            : {}),
        },
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      await this.#abortId(id);
    }
  }
}
