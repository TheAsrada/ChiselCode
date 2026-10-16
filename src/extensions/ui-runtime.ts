import {
  type ExtensionDiagnostic,
  ExternalExtensionLoader,
} from "./external/loader.js";
import { inspectPackage } from "./external/package.js";
import { extensionRecords } from "./external/registry.js";
import {
  canonicalWorkspaceRoot,
  ExtensionHost,
  type WorkspaceExtensionScope,
} from "./host.js";

type Mount = { host: ExtensionHost; scope: WorkspaceExtensionScope };
/** Live UI mounts have per-extension lifetimes, independent of core services and other mods. */
export class UiExtensionRuntime {
  private roots = new Set<string>();
  private mounts = new Map<string, Promise<Mount>>();
  private scopes = new Map<string, WorkspaceExtensionScope>();
  private listeners = new Set<() => void>();
  private known = new Set<string>();
  private blocked = new Set<string>();
  private failures = new Map<string, ExtensionDiagnostic>();
  private closed = false;
  private refreshing: Promise<void> = Promise.resolve();
  constructor(
    private disabled = false,
    private canMount: (id: string) => boolean = () => true,
  ) {}
  canApply(id: string) {
    return (
      !this.disabled &&
      !this.closed &&
      !this.blocked.has(id) &&
      this.canMount(id)
    );
  }
  subscribe = (changed: () => void) => {
    this.listeners.add(changed);
    return () => {
      this.listeners.delete(changed);
    };
  };
  async open(
    root: string,
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceExtensionScope[]> {
    if (this.closed || this.disabled) return [];
    await this.refreshing;
    const canonical = await canonicalWorkspaceRoot(root);
    if (this.closed || signal?.aborted) return [];
    this.roots.add(canonical);
    const records = await extensionRecords();
    const ids = (
      await Promise.all(
        records.map(async (record) => {
          try {
            if (
              (await inspectPackage(record.location)).manifest.kind === "ui"
            ) {
              this.known.add(record.id);
              return record.enabled ? record.id : undefined;
            }
          } catch {
            /* Invalid packages are diagnosed by the ordinary catalog. */
          }
          return undefined;
        }),
      )
    ).filter((id): id is string => !!id);
    if (this.closed || signal?.aborted || !this.roots.has(canonical)) return [];
    const scopes = await Promise.all(
      ids.map((id) => this.acquire(canonical, id)),
    );
    return scopes.filter((scope): scope is WorkspaceExtensionScope => !!scope);
  }
  private async acquire(
    root: string,
    id: string,
  ): Promise<WorkspaceExtensionScope | undefined> {
    if (!this.canApply(id)) return;
    const key = JSON.stringify([root, id]);
    let pending = this.mounts.get(key);
    if (!pending) {
      pending = (async () => {
        const loader = await ExternalExtensionLoader.create(() => {}, "ui", id);
        const host = new ExtensionHost(loader.definitions([]));
        try {
          return { host, scope: await host.open(root) };
        } catch (error) {
          await host.dispose();
          throw error;
        }
      })();
      this.mounts.set(key, pending);
    }
    try {
      const { scope } = await pending;
      if (!this.closed && this.mounts.get(key) === pending)
        this.scopes.set(key, scope);
      return scope;
    } catch {
      if (this.mounts.get(key) === pending) this.mounts.delete(key);
      return;
    }
  }
  diagnostics(root?: string): readonly ExtensionDiagnostic[] {
    return [
      ...[...this.scopes.values()].flatMap((scope) => {
        try {
          return scope.externalDiagnostics();
        } catch {
          return [];
        }
      }),
      ...this.failures.values(),
    ].filter((diagnostic) => !root || diagnostic.workspaceRoot === root);
  }
  private async closeMount(key: string, pending: Promise<Mount>) {
    this.mounts.delete(key);
    this.scopes.delete(key);
    const { host, scope } = await pending;
    const diagnostics = scope.externalDiagnostics();
    try {
      await host.dispose();
    } catch (error) {
      for (const diagnostic of diagnostics) {
        this.blocked.add(diagnostic.id);
        this.failures.set(key, {
          ...diagnostic,
          state: "cleanup_failed",
          reason:
            "Очистка UI расширения не подтверждена; нужен перезапуск приложения.",
        });
      }
      throw error;
    }
  }
  /** Invoked only after Settings commits an exact reviewed package/setting revision. */
  async changed(id: string): Promise<boolean> {
    if (this.closed || this.disabled) return false;
    const record = (await extensionRecords()).find(
      (record) => record.id === id,
    );
    let isUi = false;
    if (record) {
      try {
        isUi = (await inspectPackage(record.location)).manifest.kind === "ui";
      } catch {
        /* A previously mounted invalid owner must still be removed. */
      }
    }
    if (!isUi && !this.known.has(id)) return false;
    this.known.add(id);
    const refresh = this.refreshing.then(async () => {
      if (this.closed) return;
      try {
        const previous = [...this.mounts].filter(
          ([key]) => (JSON.parse(key) as string[])[1] === id,
        );
        const results = await Promise.allSettled(
          previous.map(([key, pending]) => this.closeMount(key, pending)),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        if (isUi && record?.enabled)
          await Promise.all(
            [...this.roots].map((root) => this.acquire(root, id)),
          );
      } finally {
        if (!this.closed) for (const changed of this.listeners) changed();
      }
    });
    this.refreshing = refresh.catch(() => {});
    await refresh;
    return (isUi && this.canApply(id)) || !record?.enabled;
  }
  async closeWorkspace(root: string) {
    const canonical = await canonicalWorkspaceRoot(root);
    const closing = this.refreshing.then(async () => {
      this.roots.delete(canonical);
      const results = await Promise.allSettled(
        [...this.mounts]
          .filter(([key]) => (JSON.parse(key) as string[])[0] === canonical)
          .map(([key, pending]) => this.closeMount(key, pending)),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    this.refreshing = closing.catch(() => {});
    await closing;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.refreshing;
    this.listeners.clear();
    this.roots.clear();
    const results = await Promise.allSettled(
      [...this.mounts].map(([key, pending]) => this.closeMount(key, pending)),
    );
    this.mounts.clear();
    this.scopes.clear();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
