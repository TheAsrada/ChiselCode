import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { cancelled } from "../runtime/errors.js";
import { ExtensionCommandContributions } from "./commands.js";
import { ContextProviderRegistry } from "./context.js";
import type {
  ChiselExtension,
  Disposable,
  ExtensionContext,
} from "./contracts.js";
import { RuntimeHookPipeline } from "./guards.js";
import {
  abortable,
  type CleanupFailure,
  cleanupFailure,
  ExtensionLifecycleError,
  validateId,
} from "./lifecycle.js";
import { ServiceRegistry } from "./services.js";
import { ExtensionToolContributions } from "./tools.js";

export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  const canonical = await realpath(resolve(root));
  return process.platform === "win32"
    ? canonical.replaceAll("/", "\\").toLowerCase()
    : canonical;
}

type ActivationResources = { extensionId: string; resources: Disposable[] };

export class WorkspaceExtensionScope implements Disposable {
  private readonly lifetime = new AbortController();
  readonly services = new ServiceRegistry();
  readonly toolGuards: RuntimeHookPipeline;
  readonly contextProviders: ContextProviderRegistry;
  readonly tools: ExtensionToolContributions;
  readonly commands: ExtensionCommandContributions;
  private readonly activations: ActivationResources[] = [];
  private readonly tracked = new Set<Disposable>();
  private disposal?: Promise<void>;
  private ready = false;
  constructor(
    readonly workspaceRoot: string,
    private readonly onClose: () => void = () => {},
  ) {
    this.toolGuards = new RuntimeHookPipeline(workspaceRoot, this.signal);
    this.contextProviders = new ContextProviderRegistry(
      workspaceRoot,
      this.signal,
    );
    this.tools = new ExtensionToolContributions(this.signal, () =>
      this.assertUsable(),
    );
    this.commands = new ExtensionCommandContributions(
      () => this.assertUsable(),
      this.signal,
    );
  }
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }
  assertUsable(): void {
    if (!this.ready || this.disposal || this.signal.aborted)
      throw new ExtensionLifecycleError(
        "Extension workspace is not available.",
      );
  }
  /** Internal lifecycle entry; definitions never receive the scope. */
  async activate(definitions: readonly ChiselExtension[]): Promise<void> {
    for (const definition of definitions) {
      cancelled(this.signal);
      const frame: ActivationResources = {
        extensionId: definition.id,
        resources: [],
      };
      this.activations.push(frame);
      let registering = true;
      const assertRegistering = () => {
        if (!registering || this.signal.aborted)
          throw new ExtensionLifecycleError(
            `Extension ${definition.id} registrations are closed.`,
            definition.id,
          );
      };
      const track = (resource: Disposable) => {
        assertRegistering();
        if (
          !resource ||
          typeof resource.dispose !== "function" ||
          this.tracked.has(resource)
        )
          throw new ExtensionLifecycleError(
            `Extension ${definition.id} registered an invalid or duplicate resource.`,
            definition.id,
          );
        this.tracked.add(resource);
        frame.resources.push(resource);
      };
      const context: ExtensionContext = Object.freeze({
        workspaceRoot: this.workspaceRoot,
        signal: this.signal,
        commands: Object.freeze({
          register: <T>(
            command: import("./contracts.js").ExtensionCommandContribution<T>,
          ) => {
            assertRegistering();
            track(this.commands.register(definition.id, command));
          },
        }),
        tools: Object.freeze({
          register: (
            tool: import("./contracts.js").ExtensionToolContribution,
          ) => {
            assertRegistering();
            track(this.tools.register(definition.id, tool));
          },
        }),
        services: Object.freeze({
          provide: <T>(
            token: import("./services.js").ServiceToken<T>,
            value: T,
          ) => {
            assertRegistering();
            track(this.services.provide(token, value));
          },
          get: <T>(token: import("./services.js").ServiceToken<T>) =>
            this.services.get(token),
          lookup: <T>(token: import("./services.js").ServiceToken<T>) =>
            this.services.lookup(token),
        }),
        guards: Object.freeze({
          afterPrepare: (guard: import("./contracts.js").ToolGuard) => {
            assertRegistering();
            track(
              this.toolGuards.register(
                definition.id,
                "tool.afterPrepare",
                guard,
              ),
            );
          },
          beforeExecute: (guard: import("./contracts.js").ToolGuard) => {
            assertRegistering();
            track(
              this.toolGuards.register(
                definition.id,
                "tool.beforeExecute",
                guard,
              ),
            );
          },
        }),
        contextProviders: Object.freeze({
          register: (
            provider: import("./contracts.js").ExtensionContextProvider,
          ) => {
            assertRegistering();
            track(this.contextProviders.register(definition.id, provider));
          },
        }),
        add: track,
      });
      try {
        await abortable(() => definition.activate(context), this.signal);
      } catch (cause) {
        throw new ExtensionLifecycleError(
          `Extension ${definition.id} activation failed.`,
          definition.id,
          cause,
        );
      } finally {
        registering = false;
      }
    }
    cancelled(this.signal);
    this.services.seal();
    this.toolGuards.seal();
    this.contextProviders.seal();
    this.tools.seal();
    this.commands.seal();
    this.ready = true;
  }
  abortLifetime(): void {
    this.lifetime.abort();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = Promise.resolve().then(async () => {
      const failures: CleanupFailure[] = [];
      for (const frame of [...this.activations].reverse())
        for (const resource of [...frame.resources].reverse()) {
          try {
            await resource.dispose();
          } catch (cause) {
            failures.push(cleanupFailure(frame.extensionId, cause));
          }
        }
      this.activations.length = 0;
      this.tracked.clear();
      this.onClose();
      if (failures.length)
        throw new ExtensionLifecycleError(
          `Extension workspace cleanup failed for ${failures.map((failure) => failure.extensionId).join(", ")}.`,
          undefined,
          undefined,
          failures,
        );
    });
    this.ready = false;
    this.services.dispose();
    this.toolGuards.dispose();
    this.contextProviders.dispose();
    this.tools.dispose();
    this.commands.dispose();
    this.abortLifetime();
    return this.disposal;
  }
}

export class ExtensionHost implements Disposable {
  private definitions: readonly ChiselExtension[];
  private readonly workspaces = new Map<
    string,
    {
      scope: WorkspaceExtensionScope;
      pending: Promise<WorkspaceExtensionScope>;
    }
  >();
  private closed = false;
  private disposal?: Promise<void>;
  constructor(definitions: readonly ChiselExtension[] = []) {
    const ids = new Set<string>();
    for (const definition of definitions) {
      validateId(definition.id, "extension");
      if (typeof definition.activate !== "function")
        throw new ExtensionLifecycleError(
          `Extension ${definition.id} has no activation function.`,
          definition.id,
        );
      if (ids.has(definition.id))
        throw new ExtensionLifecycleError(
          `Duplicate extension ${definition.id}.`,
          definition.id,
        );
      ids.add(definition.id);
    }
    this.definitions = definitions.map((definition) =>
      Object.freeze({
        id: definition.id,
        activate: definition.activate.bind(definition),
      }),
    );
  }
  async open(root: string): Promise<WorkspaceExtensionScope> {
    if (this.closed)
      throw new ExtensionLifecycleError("Extension host is closed.");
    const canonical = await canonicalWorkspaceRoot(root);
    if (this.closed)
      throw new ExtensionLifecycleError("Extension host is closed.");
    const existing = this.workspaces.get(canonical);
    if (existing) {
      const scope = await existing.pending;
      scope.assertUsable();
      return scope;
    }
    const scope = new WorkspaceExtensionScope(canonical, () => {
      if (this.workspaces.get(canonical)?.scope === scope)
        this.workspaces.delete(canonical);
    });
    const definitions = this.definitions;
    const pending = Promise.resolve().then(async () => {
      try {
        await scope.activate(definitions);
        if (this.closed)
          throw new ExtensionLifecycleError(
            "Extension host closed during activation.",
          );
        scope.assertUsable();
        return scope;
      } catch (error) {
        try {
          await scope.dispose();
        } catch (cleanup) {
          throw new ExtensionLifecycleError(
            error instanceof Error
              ? error.message
              : "Extension activation failed.",
            error instanceof ExtensionLifecycleError
              ? error.extensionId
              : undefined,
            error,
            cleanup instanceof ExtensionLifecycleError
              ? cleanup.cleanupFailures
              : [cleanupFailure("host", cleanup)],
          );
        }
        throw error;
      }
    });
    this.workspaces.set(canonical, { scope, pending });
    return pending;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    const entries = [...this.workspaces.values()].reverse();
    this.definitions = [];
    this.disposal = Promise.resolve().then(async () => {
      const failures: CleanupFailure[] = [];
      for (const entry of entries) {
        await entry.pending.catch(() => {});
        try {
          await entry.scope.dispose();
        } catch (error) {
          failures.push(
            ...(error instanceof ExtensionLifecycleError
              ? error.cleanupFailures
              : [cleanupFailure("host", error)]),
          );
        }
      }
      this.workspaces.clear();
      if (failures.length)
        throw new ExtensionLifecycleError(
          `Extension host cleanup failed for ${[...new Set(failures.map((failure) => failure.extensionId))].join(", ")}.`,
          undefined,
          undefined,
          failures,
        );
    });
    for (const { scope } of entries) scope.abortLifetime();
    return this.disposal;
  }
}
