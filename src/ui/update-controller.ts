import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  checkForUpdates,
  type DownloadedAsset,
  type DownloadOptions,
  downloadReleaseAsset,
  manualInstallCommand,
  planSelfUpdate,
  type SelfUpdatePlan,
  type UpdateCheckOptions,
  type UpdateCheckResult,
} from "../commands/update.js";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "unavailable"
  | "downloading"
  | "verifying"
  | "ready"
  | "launching"
  | "cancelled"
  | "error";

export interface UpdateState {
  current: string;
  phase: UpdatePhase;
  plan?: SelfUpdatePlan;
  downloaded?: DownloadedAsset;
  bytes: number;
  totalBytes?: number;
  error?: string;
}

export interface UpdateDependencies {
  check: (
    current: string,
    options: UpdateCheckOptions,
  ) => Promise<UpdateCheckResult>;
  plan: (check: UpdateCheckResult, current: string) => SelfUpdatePlan;
  download: (
    url: string,
    asset: string,
    options: DownloadOptions,
  ) => Promise<DownloadedAsset>;
  remove: (downloaded: DownloadedAsset) => Promise<void>;
  launch: (downloaded: DownloadedAsset) => Promise<void>;
  canRestart: () => boolean;
  now: () => number;
}

const CHECK_CACHE_MS = 10 * 60_000;

/** One updater per application, independent of the selected chat tab. */
export class UpdateController {
  private state: UpdateState;
  private listeners = new Set<(state: UpdateState) => void>();
  private dependencies: UpdateDependencies;
  private abort?: AbortController;
  private operation = 0;
  private checkedAt?: number;
  private tasks = new Set<Promise<void>>();
  private checking?: Promise<void>;
  private disposed = false;
  private handedOff = false;

  constructor(current: string, dependencies: Partial<UpdateDependencies> = {}) {
    this.state = { current, phase: "idle", bytes: 0 };
    this.dependencies = {
      check: checkForUpdates,
      plan: planSelfUpdate,
      download: downloadReleaseAsset,
      remove: async (downloaded) => {
        await rm(dirname(downloaded.path), { recursive: true, force: true });
      },
      launch: async () => {
        throw new Error("Запуск установщика недоступен.");
      },
      canRestart: () => true,
      now: () => performance.now(),
      ...dependencies,
    };
  }

  get snapshot(): UpdateState {
    return this.state;
  }

  get busy(): boolean {
    return ["checking", "downloading", "verifying", "launching"].includes(
      this.state.phase,
    );
  }

  get canRestart(): boolean {
    return this.dependencies.canRestart();
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  check(force = false): Promise<void> {
    if (this.disposed || this.state.downloaded) return Promise.resolve();
    if (this.busy) return this.checking ?? Promise.resolve();
    if (
      !force &&
      this.checkedAt !== undefined &&
      this.dependencies.now() - this.checkedAt < CHECK_CACHE_MS &&
      !["error", "cancelled", "unavailable"].includes(this.state.phase)
    )
      return Promise.resolve();
    const operation = ++this.operation;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ phase: "checking", error: undefined });
    const task = (async () => {
      try {
        const check = await this.dependencies.check(this.state.current, {
          signal: abort.signal,
        });
        if (!this.isCurrent(operation)) return;
        const plan = this.dependencies.plan(check, this.state.current);
        this.checkedAt = this.dependencies.now();
        this.set({
          plan,
          bytes: 0,
          totalBytes: plan.assetSize,
          error: plan.error,
          phase: plan.error
            ? "error"
            : !plan.updateAvailable
              ? "current"
              : plan.assetReady === false
                ? "unavailable"
                : "available",
        });
      } catch (error) {
        if (this.isCurrent(operation))
          this.set({ phase: "error", error: errorText(error) });
      }
    })();
    this.checking = task;
    this.track(task);
    void task.finally(() => {
      if (this.checking === task) this.checking = undefined;
    });
    return task;
  }

  prepare(): Promise<void> {
    if (this.disposed || this.busy || this.state.downloaded)
      return Promise.resolve();
    const plan = this.state.plan;
    if (
      !plan?.updateAvailable ||
      plan.error ||
      !plan.installedBinary ||
      plan.assetReady !== true ||
      !plan.sha256 ||
      !plan.assetSize
    )
      return this.check(true);
    const operation = ++this.operation;
    const abort = new AbortController();
    this.abort = abort;
    this.set({
      phase: "downloading",
      bytes: 0,
      totalBytes: plan.assetSize,
      error: undefined,
    });
    let reportedAt = -Infinity;
    const task = (async () => {
      try {
        const downloaded = await this.dependencies.download(
          plan.url,
          plan.asset,
          {
            expectedBytes: plan.assetSize,
            expectedSha256: plan.sha256,
            signal: abort.signal,
            onProgress: (progress) => {
              if (!this.isCurrent(operation)) return;
              const now = this.dependencies.now();
              if (
                progress.phase === "verifying" ||
                progress.bytes === progress.totalBytes ||
                now - reportedAt >= 100
              ) {
                reportedAt = now;
                this.set({ ...progress, error: undefined });
              }
            },
          },
        );
        if (!this.isCurrent(operation)) {
          await this.dependencies.remove(downloaded).catch(() => {});
          return;
        }
        this.set({
          phase: "ready",
          plan: {
            ...plan,
            manualCommand: plan.autoInstall
              ? undefined
              : manualInstallCommand(downloaded.path, plan.platform),
          },
          downloaded,
          bytes: downloaded.bytes,
          totalBytes: downloaded.bytes,
        });
      } catch (error) {
        if (this.isCurrent(operation))
          this.set({ phase: "error", error: errorText(error) });
      }
    })();
    return this.track(task);
  }

  restart(): Promise<void> {
    if (
      this.disposed ||
      this.busy ||
      !this.state.downloaded ||
      !this.state.plan?.autoInstall
    )
      return Promise.resolve();
    if (!this.canRestart) {
      this.set({
        error: "Дождитесь завершения запроса и очереди перед перезапуском.",
      });
      return Promise.resolve();
    }
    const downloaded = this.state.downloaded;
    this.set({ phase: "launching", error: undefined });
    const task = (async () => {
      try {
        await this.dependencies.launch(downloaded);
        this.handedOff = true;
      } catch (error) {
        this.set({ phase: "ready", error: errorText(error) });
      }
    })();
    return this.track(task);
  }

  cancel(): void {
    if (!this.busy || this.state.phase === "launching") return;
    this.operation++;
    this.abort?.abort();
    this.checking = undefined;
    this.set({ phase: "cancelled", error: undefined, bytes: 0 });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.operation++;
    this.abort?.abort();
    this.listeners.clear();
    await Promise.allSettled(this.tasks);
    // Manual package installation may happen after closing the application.
    if (
      this.state.downloaded &&
      !this.handedOff &&
      this.state.plan?.autoInstall
    )
      await this.dependencies.remove(this.state.downloaded).catch(() => {});
  }

  private isCurrent(operation: number): boolean {
    return !this.disposed && this.operation === operation;
  }

  private track(task: Promise<void>): Promise<void> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return task;
  }

  private set(fields: Partial<UpdateState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...fields };
    for (const listener of this.listeners) listener(this.state);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
