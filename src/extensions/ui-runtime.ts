import { resolve } from "node:path";
import {
  type ExtensionDiagnostic,
  ExternalExtensionLoader,
} from "./external/loader.js";
import { canonicalPath, inspectPackage } from "./external/package.js";
import {
  readExtensionRegistry,
  runtimeRecord,
  selectedVersion,
  withExtensionRegistry,
} from "./external/registry.js";
import {
  canonicalWorkspaceRoot,
  ExtensionHost,
  type WorkspaceExtensionScope,
} from "./host.js";

import { settlePackageActivation } from "./packages/activation.js";

type Mount = { host: ExtensionHost; scope: WorkspaceExtensionScope };
/** Live UI mounts have per-extension lifetimes, independent of core services and other mods. */
export class UiExtensionRuntime {
  private roots = new Set<string>();
  private aliases = new Map<string, string>();
  private mounts = new Map<string, Promise<Mount>>();
  private scopes = new Map<string, WorkspaceExtensionScope>();
  private hosts = new Map<string, ExtensionHost>();
  private listeners = new Set<() => void>();
  private known = new Set<string>();
  private blocked = new Set<string>();
  private suspended = new Set<string>();
  private failures = new Map<string, ExtensionDiagnostic>();
  private closingDiagnostics = new Map<
    string,
    readonly ExtensionDiagnostic[]
  >();
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
    this.aliases.set(canonicalPath(resolve(root)), canonical);
    this.roots.add(canonical);
    const records = (await readExtensionRegistry()).records;
    const ids = (
      await Promise.all(
        records.map(async (row) => {
          const record = runtimeRecord(row);
          if (!record) return;
          try {
            if (
              (selectedVersion(row)?.extensionKind ??
                (await inspectPackage(record.location)).manifest.kind) === "ui"
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
    if (!this.canApply(id) || this.suspended.has(id)) return;
    const key = JSON.stringify([root, id]);
    let pending = this.mounts.get(key);
    if (!pending) {
      pending = (async () => {
        const loader = await ExternalExtensionLoader.create(() => {}, "ui", id);
        const host = new ExtensionHost(loader.definitions([]));
        this.hosts.set(key, host);
        try {
          if (this.suspended.has(id)) throw new Error("Расширение выключено.");
          return { host, scope: await host.open(root) };
        } catch (error) {
          this.hosts.delete(key);
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
    const canonical = root
      ? (this.aliases.get(canonicalPath(resolve(root))) ??
        canonicalPath(resolve(root)))
      : undefined;
    return [
      ...[...this.scopes.values()].flatMap((scope) => {
        try {
          return scope.externalDiagnostics();
        } catch {
          return [];
        }
      }),
      ...this.failures.values(),
    ].filter(
      (diagnostic) => !canonical || diagnostic.workspaceRoot === canonical,
    );
  }
  private async closeMount(key: string, pending: Promise<Mount>) {
    this.mounts.delete(key);
    this.scopes.delete(key);
    this.hosts.delete(key);
    const mount = await pending.catch(() => undefined);
    if (!mount) {
      this.closingDiagnostics.delete(key);
      return;
    }
    const { host, scope } = mount;
    const diagnostics =
      this.closingDiagnostics.get(key) ?? scope.externalDiagnostics();
    this.closingDiagnostics.delete(key);
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
  needsRestart(id: string): boolean {
    return this.blocked.has(id);
  }
  publish(): void {
    if (!this.closed) for (const changed of this.listeners) changed();
  }
  suspend(id: string): void {
    this.suspended.add(id);
    for (const [key, host] of this.hosts)
      if ((JSON.parse(key) as string[])[1] === id) {
        const scope = this.scopes.get(key);
        if (scope && !scope.signal.aborted)
          this.closingDiagnostics.set(key, scope.externalDiagnostics());
        host.abortWorkspaces();
      }
    this.publish();
  }
  /** Invoked only after Settings commits an exact reviewed package/setting revision. */
  async changed(id: string): Promise<boolean> {
    if (this.closed || this.disabled) return false;
    let applied = false;
    const refresh = this.refreshing
      .then(async () => {
        if (this.closed) return;
        const row = (await readExtensionRegistry()).records.find(
          (record) => record.id === id,
        );
        const record = row && runtimeRecord(row);
        let isUi = false;
        if (record) {
          try {
            isUi =
              (selectedVersion(row)?.extensionKind ??
                (await inspectPackage(record.location)).manifest.kind) === "ui";
          } catch {
            /* A previously mounted invalid owner still needs recovery. */
          }
        }
        if (!isUi && !this.known.has(id)) return;
        this.known.add(id);
        const previous = [...this.mounts].filter(
          ([key]) => (JSON.parse(key) as string[])[1] === id,
        );
        if (!record?.enabled) {
          this.suspend(id);
          await this.closePrevious(previous);
          applied = true;
          return;
        }
        if (!isUi || !row || !this.canApply(id)) return;
        const staged = new Map<string, Mount>();
        try {
          await Promise.allSettled(
            [...this.roots].map(async (root) => {
              const key = JSON.stringify([root, id]);
              const loader = await ExternalExtensionLoader.create(
                () => {},
                "ui",
                id,
                true,
              );
              const host = new ExtensionHost(loader.definitions([]));
              try {
                const scope = await host.open(root);
                staged.set(key, { host, scope });
              } catch (error) {
                await host.dispose();
                throw error;
              }
            }),
          ).then((results) => {
            const failure = results.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") throw failure.reason;
          });
          const diagnostics = [...staged.values()].flatMap(({ scope }) =>
            scope.externalDiagnostics(),
          );
          const failure = diagnostics.find(
            ({ state }) => state !== "active" && state !== "disabled",
          );
          const active = diagnostics.some(
            (diagnostic) => diagnostic.state === "active",
          );
          if (failure || (staged.size && !diagnostics.length)) {
            const fallback = await settlePackageActivation(row, false);
            if (failure)
              this.failures.set(
                JSON.stringify([failure.workspaceRoot, id]),
                failure,
              );
            if (fallback) {
              this.suspended.delete(id);
              const missing = [...this.roots].filter(
                (root) => !this.mounts.has(JSON.stringify([root, id])),
              );
              await Promise.all(missing.map((root) => this.acquire(root, id)));
              for (const [key] of this.mounts)
                if ((JSON.parse(key) as string[])[1] === id)
                  this.failures.delete(key);
              applied = true;
            } else {
              const current = (await readExtensionRegistry()).records.find(
                (item) => item.id === id,
              );
              const stillWorking =
                row.lastWorking === row.selected &&
                previous.some(([key]) =>
                  this.scopes
                    .get(key)
                    ?.externalDiagnostics()
                    .some(
                      (diagnostic) =>
                        diagnostic.state === "active" &&
                        diagnostic.packageDigest === record.digest,
                    ),
                );
              if (current?.revision === row.revision && !stillWorking) {
                this.suspend(id);
                await this.closePrevious(previous);
              }
            }
            return;
          }
          let closing: Promise<void> | undefined;
          const publish = () => {
            if (this.closed) return;
            this.suspended.delete(id);
            // Revoke and replace inside the same registry CAS.
            for (const [key] of previous) {
              const scope = this.scopes.get(key);
              if (scope && !scope.signal.aborted)
                this.closingDiagnostics.set(key, scope.externalDiagnostics());
              this.hosts.get(key)?.abortWorkspaces();
            }
            closing = this.closePrevious(previous);
            for (const [key, mount] of staged) {
              this.scopes.set(key, mount.scope);
              this.hosts.set(key, mount.host);
              this.mounts.set(key, Promise.resolve(mount));
              this.failures.delete(key);
            }
            staged.clear();
          };
          if (active)
            await settlePackageActivation(row, true, undefined, publish);
          else
            await withExtensionRegistry(async (registry) => {
              const current = registry.records.find((item) => item.id === id);
              if (current?.enabled && current.revision === row.revision)
                publish();
            });
          if (!closing) return;
          this.publish();
          try {
            await closing;
            applied = true;
          } catch (error) {
            this.suspend(id);
            await this.closePrevious(
              [...this.mounts].filter(
                ([key]) => (JSON.parse(key) as string[])[1] === id,
              ),
            ).catch(() => {});
            throw error;
          }
        } finally {
          await Promise.all(
            [...staged.values()].map(({ host }) => host.dispose()),
          );
        }
      })
      .finally(() => this.publish());
    this.refreshing = refresh.catch(() => {});
    await refresh;
    return applied;
  }
  private async closePrevious(previous: [string, Promise<Mount>][]) {
    const results = await Promise.allSettled(
      previous.map(([key, pending]) => this.closeMount(key, pending)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  async closeWorkspace(root: string) {
    const canonical =
      this.aliases.get(canonicalPath(resolve(root))) ??
      (await canonicalWorkspaceRoot(root));
    const closing = this.refreshing.then(async () => {
      this.roots.delete(canonical);
      for (const [alias, target] of this.aliases)
        if (target === canonical) this.aliases.delete(alias);
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
    this.aliases.clear();
    const results = await Promise.allSettled(
      [...this.mounts].map(([key, pending]) => this.closeMount(key, pending)),
    );
    this.mounts.clear();
    this.scopes.clear();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
