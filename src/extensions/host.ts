import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AutomationDefinition } from "../extension-sdk/automations.js";
import {
  admitWorkspace,
  revalidateWorkspace,
  type WorkspaceRef,
} from "../projects/admission.js";
import { cancelled } from "../runtime/errors.js";
import { ThemeCatalog } from "../themes/catalog.js";
import { inheritThemeSource, themeSource } from "../themes/source.js";
import { ExtensionActivation } from "./activation.js";
import { AgentEventPipeline } from "./agent-events.js";
import {
  type AutomationDispatch,
  captureAutomation,
  ExtensionAutomations,
} from "./automations.js";
import { ExtensionChatViews } from "./chat.js";
import { ExtensionCommandContributions } from "./commands.js";
import { ContextProviderRegistry } from "./context.js";
import type {
  ChiselExtension,
  Disposable,
  ExtensionContext,
} from "./contracts.js";
import {
  type ApplicationResource,
  applicationResource,
} from "./external/application-resource.js";
import {
  inheritOptional,
  optionalClaim,
  optionalDiagnostic,
  optionalOutcome,
  optionalTransition,
} from "./external/optional.js";
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
import { ExtensionUiRegistry } from "./ui.js";

export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  const canonical = await realpath(resolve(root));
  return process.platform === "win32"
    ? canonical.replaceAll("/", "\\").toLowerCase()
    : canonical;
}

type ActivationResources = {
  extensionId: string;
  resources: Disposable[];
  registrations: Disposable[];
  owner: ExtensionActivation;
  automations: AutomationDefinition[];
};

export class WorkspaceExtensionScope implements Disposable {
  private readonly lifetime = new AbortController();
  private registering = false;
  private staging = () => this.registering;
  readonly services = new ServiceRegistry(undefined, this.staging);
  readonly toolGuards: RuntimeHookPipeline;
  readonly contextProviders: ContextProviderRegistry;
  readonly tools: ExtensionToolContributions;
  readonly commands: ExtensionCommandContributions;
  readonly chat: ExtensionChatViews;
  readonly ui: ExtensionUiRegistry;
  readonly events: AgentEventPipeline;
  private readonly activations: ActivationResources[] = [];
  readonly automations: ExtensionAutomations;
  private readonly cleanupErrors = new Set<string>();
  private readonly tracked = new Set<Disposable>();
  private disposal?: Promise<void>;
  private ready = false;
  private definitions: readonly ChiselExtension[] = [];
  /** Cached runtime metadata only: no import, file reads or mutable extension authority. */
  externalDiagnostics(): readonly import("./external/loader.js").ExtensionDiagnostic[] {
    this.assertUsable();
    return this.definitions.flatMap((definition) => {
      const diagnostic = optionalDiagnostic(definition, this.workspaceRoot);
      return diagnostic ? [Object.freeze({ ...diagnostic })] : [];
    });
  }
  constructor(
    readonly workspaceRoot: string,
    private readonly onClose: () => void = () => {},
    dispatch?: (scope: WorkspaceExtensionScope) => AutomationDispatch,
    private readonly checkOwner: (
      id: string,
    ) => boolean | Promise<boolean> = () => true,
    automationChanged?: () => void,
  ) {
    this.automations = new ExtensionAutomations(
      dispatch?.(this),
      automationChanged,
    );
    this.events = new AgentEventPipeline(
      workspaceRoot,
      this.signal,
      this.staging,
    );
    this.chat = new ExtensionChatViews(
      () => this.assertUsable(),
      this.staging,
      (id) => !!this.activation(id),
    );
    this.ui = new ExtensionUiRegistry(
      workspaceRoot,
      this.signal,
      () => this.assertUsable(),
      (name) => this.commands.registeredOwner(name),
      (owner, name) => this.tools.hasOwned(owner, name),
      this.staging,
      (id) =>
        this.activations.some(
          (frame) =>
            frame.extensionId === id &&
            frame.owner.published &&
            !frame.owner.signal.aborted,
        ),
    );
    this.toolGuards = new RuntimeHookPipeline(
      workspaceRoot,
      this.signal,
      this.staging,
    );
    this.contextProviders = new ContextProviderRegistry(
      workspaceRoot,
      this.signal,
      this.staging,
    );
    this.tools = new ExtensionToolContributions(
      this.signal,
      () => this.assertUsable(),
      this.chat,
      this.staging,
    );
    this.commands = new ExtensionCommandContributions(
      () => this.assertUsable(),
      this.signal,
      this.chat,
      this.staging,
      (id) => !!this.activation(id),
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
  async activate(
    definitions: readonly ChiselExtension[],
    available: (id: string) => boolean | Promise<boolean> = () => true,
  ): Promise<void> {
    this.definitions = definitions;
    for (const definition of definitions)
      if (await available(definition.id)) await this.activateOwner(definition);
    cancelled(this.signal);
    this.services.seal();
    this.toolGuards.seal();
    this.contextProviders.seal();
    this.tools.seal();
    this.commands.seal();
    this.chat.seal();
    this.ui.seal();
    this.events.seal();
    this.ready = true;
    for (const definition of definitions)
      if (this.activations.some((frame) => frame.extensionId === definition.id))
        this.publishOwner(definition);
  }
  activation(id: string): ExtensionActivation | undefined {
    return this.activations.find(
      (frame) => frame.extensionId === id && frame.owner.available,
    )?.owner;
  }
  private publishOwner(definition: ChiselExtension) {
    const frame = this.activations.find(
      (item) => item.extensionId === definition.id,
    );
    if (!frame || frame.owner.signal.aborted) return;
    optionalOutcome(definition)?.("active", this.workspaceRoot);
    frame.owner.published = true;
    this.tools.publish();
    const packageClaim = optionalClaim(definition);
    this.automations.publish(frame.owner, frame.automations, async (claim) => {
      if (!(await this.checkOwner(definition.id))) return;
      return packageClaim ? packageClaim(this.workspaceRoot, claim) : claim();
    });
  }
  private async activateOwner(
    definition: ChiselExtension,
    retry = true,
  ): Promise<void> {
    cancelled(this.signal);
    const frame: ActivationResources = {
      extensionId: definition.id,
      resources: [],
      registrations: [],
      owner: new ExtensionActivation(
        definition.id,
        this.workspaceRoot,
        this.signal,
      ),
      automations: [],
    };
    const optional = optionalOutcome(definition);
    const frameSignal = frame.owner.signal;
    this.activations.push(frame);
    let registering = true;
    const assertRegistering = () => {
      if (!registering || frameSignal.aborted)
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
    const register = (registration: () => Disposable) => {
      assertRegistering();
      this.registering = true;
      try {
        const resource = registration();
        track(resource);
        frame.registrations.push(resource);
      } finally {
        this.registering = false;
      }
    };
    const context: ExtensionContext = Object.freeze({
      automations: Object.freeze({
        register: (definition: AutomationDefinition) => {
          assertRegistering();
          const task = captureAutomation(frame.extensionId, definition);
          if (
            frame.automations.length >= 32 ||
            frame.automations.some(({ id }) => id === task.id)
          )
            throw new Error(
              "Повторный ID или исчерпан лимит автоматизаций расширения.",
            );
          frame.automations.push(task);
        },
      }),
      events: Object.freeze({
        on: <
          K extends
            keyof import("../extension-sdk/agent-events.js").AgentEventData,
        >(
          type: K,
          handler: import("../extension-sdk/agent-events.js").AgentEventHandler<K>,
        ) => {
          assertRegistering();
          register(() =>
            this.events.on(
              definition.id,
              type,
              (event, next) => frame.owner.run(() => handler(event, next)),
              frame.owner,
            ),
          );
        },
        observe: (
          handler: Parameters<
            import("../extension-sdk/agent-events.js").AgentEvents["observe"]
          >[0],
        ) => {
          assertRegistering();
          register(() =>
            this.events.observe(definition.id, handler, frame.owner),
          );
        },
      }),
      workspaceRoot: this.workspaceRoot,
      workspaceSignal: this.signal,
      signal: frameSignal,
      chat: Object.freeze({
        register: (view: import("./contracts.js").ExtensionChatView) => {
          assertRegistering();
          register(() => this.chat.register(definition.id, view));
        },
      }),
      ui: Object.freeze({
        on: (id: string, handler: import("./ui-types.js").UiEventHandler) => {
          assertRegistering();
          register(() =>
            this.ui.on(definition.id, id, (binding, event, args) =>
              frame.owner.run(() =>
                handler(
                  Object.freeze({
                    ...binding,
                    signal: AbortSignal.any([binding.signal, frameSignal]),
                  }),
                  event,
                  args,
                ),
              ),
            ),
          );
        },
        register: (contribution: import("./ui-types.js").UiContribution) => {
          assertRegistering();
          register(() => this.ui.register(definition.id, contribution));
        },
        registerView: (view: import("./ui-types.js").UiDetailsView) => {
          assertRegistering();
          register(() => this.ui.registerView(definition.id, view));
        },
      }),
      commands: Object.freeze({
        register: <T>(
          command: import("./contracts.js").ExtensionCommandContribution<T>,
        ) => {
          assertRegistering();
          register(() =>
            this.commands.register(definition.id, command, frameSignal),
          );
        },
      }),
      tools: Object.freeze({
        register: (
          tool: import("./contracts.js").ExtensionToolContribution,
        ) => {
          assertRegistering();
          register(() =>
            this.tools.register(definition.id, tool, frameSignal, frame.owner),
          );
        },
      }),
      services: Object.freeze({
        provide: <T>(
          token: import("./services.js").ServiceToken<T>,
          value: T,
        ) => {
          assertRegistering();
          register(() => this.services.provide(token, value, frame.owner));
        },
        get: <T>(token: import("./services.js").ServiceToken<T>) =>
          this.services.get(token, frame.owner),
        lookup: <T>(token: import("./services.js").ServiceToken<T>) =>
          this.services.lookup(token, frame.owner),
      }),
      guards: Object.freeze({
        afterPrepare: (guard: import("./contracts.js").ToolGuard) => {
          assertRegistering();
          register(() =>
            this.toolGuards.register(
              definition.id,
              "tool.afterPrepare",
              (snapshot) => frame.owner.run(() => guard(snapshot)),
              frame.owner,
            ),
          );
        },
        beforeExecute: (guard: import("./contracts.js").ToolGuard) => {
          assertRegistering();
          register(() =>
            this.toolGuards.register(
              definition.id,
              "tool.beforeExecute",
              (snapshot) => frame.owner.run(() => guard(snapshot)),
              frame.owner,
            ),
          );
        },
      }),
      contextProviders: Object.freeze({
        register: (
          provider: import("./contracts.js").ExtensionContextProvider,
        ) => {
          assertRegistering();
          register(() =>
            this.contextProviders.register(
              definition.id,
              provider,
              frame.owner,
            ),
          );
        },
      }),
      add: track,
    });
    try {
      await abortable(
        () => definition.activate(context),
        optional
          ? AbortSignal.any([frameSignal, AbortSignal.timeout(10000)])
          : frameSignal,
      );
      this.ui.validateOwner(definition.id);
      if (
        frameSignal.aborted ||
        (optionalTransition(definition) &&
          !(await optionalTransition(definition)!(
            this.workspaceRoot,
            true,
            frameSignal,
          )))
      )
        throw new Error("Выбор расширения изменился до публикации.");
      frame.owner.published = true;
    } catch (cause) {
      registering = false;
      frame.owner.revoke();
      if (optional && !this.signal.aborted) {
        const failures = await this.cleanupFrame(frame);
        optional(
          failures.length ? "cleanup_failed" : "activation_failed",
          this.workspaceRoot,
        );
        if (
          retry &&
          !failures.length &&
          !this.signal.aborted &&
          (await optionalTransition(definition)?.(
            this.workspaceRoot,
            false,
            this.signal,
          ))
        )
          await this.activateOwner(definition, false);
        return;
      }
      throw new ExtensionLifecycleError(
        `Extension ${definition.id} activation failed.`,
        definition.id,
        cause,
      );
    } finally {
      registering = false;
    }
  }

  private async cleanupFrame(
    frame: ActivationResources,
  ): Promise<CleanupFailure[]> {
    const failures: CleanupFailure[] = [];
    this.automations.revoke(frame.owner);
    try {
      await frame.owner.drain();
    } catch (cause) {
      failures.push(cleanupFailure(frame.extensionId, cause));
    }
    const definition = this.definitions.find(
      (item) => item.id === frame.extensionId,
    );
    const budget =
      definition && optionalOutcome(definition)
        ? AbortSignal.timeout(10000)
        : undefined;
    for (const resource of [...frame.resources].reverse()) {
      try {
        const pending = Promise.resolve(resource.dispose());
        pending.catch(() => {});
        if (budget) await abortable(() => pending, budget);
        else await pending;
      } catch (cause) {
        failures.push(cleanupFailure(frame.extensionId, cause));
      }
      this.tracked.delete(resource);
    }
    this.activations.splice(this.activations.indexOf(frame), 1);
    if (failures.length) this.cleanupErrors.add(frame.extensionId);
    return failures;
  }

  abortOwner(id: string): void {
    const frame = this.activations.find((item) => item.extensionId === id);
    if (!frame) return;
    frame.owner.revoke();
    this.automations.revoke(frame.owner);
    for (const resource of frame.registrations) {
      void resource.dispose();
      this.tracked.delete(resource);
    }
    frame.resources = frame.resources.filter(
      (resource) => !frame.registrations.includes(resource),
    );
    frame.registrations = [];
    if (this.ready) this.tools.publish();
    this.ui.invalidateBindings();
  }

  async setOwnerAvailable(id: string, available: boolean): Promise<void> {
    this.assertUsable();
    const definition = this.definitions.find((item) => item.id === id);
    if (!definition) return;
    const frame = this.activations.find((item) => item.extensionId === id);
    if (available && this.cleanupErrors.has(id))
      throw new ExtensionLifecycleError(
        "Очистка расширения не подтверждена.",
        id,
      );
    if (available && !frame) {
      try {
        await this.activateOwner(definition);
        this.publishOwner(definition);
      } catch (error) {
        const failed = this.activations.find((item) => item.extensionId === id);
        if (failed) await this.cleanupFrame(failed);
        throw error;
      }
    } else if (!available && frame) {
      this.abortOwner(id);
      const failures = await this.cleanupFrame(frame);
      optionalOutcome(definition)?.(
        failures.length ? "cleanup_failed" : "disposed",
        this.workspaceRoot,
      );
      if (failures.length)
        throw new ExtensionLifecycleError(
          "Не удалось освободить ресурсы расширения.",
          id,
          undefined,
          failures,
        );
    }
  }
  abortLifetime(): void {
    this.lifetime.abort();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = Promise.resolve().then(async () => {
      const failures: CleanupFailure[] = [];
      for (const frame of [...this.activations].reverse()) {
        frame.owner.revoke();
        const definition = this.definitions.find(
          (item) => item.id === frame.extensionId,
        );
        const errors = await this.cleanupFrame(frame);
        failures.push(...errors);
        if (definition)
          optionalOutcome(definition)?.(
            errors.length ? "cleanup_failed" : "disposed",
            this.workspaceRoot,
          );
      }
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
    this.chat.dispose();
    this.ui.dispose();
    this.events.dispose();
    this.abortLifetime();
    return this.disposal;
  }
}

export class ExtensionHost implements Disposable {
  private readonly applicationResources = new Set<ApplicationResource>();
  readonly themes = new ThemeCatalog();
  private readonly themeOwners = new Set<string>();
  private readonly suspended = new Set<string>();
  private readonly restart = new Set<string>();
  private readonly cleanupBlocked = new Set<string>();
  private ownerAvailable: (
    id: string,
    root: string,
  ) => boolean | Promise<boolean> = () => true;
  private ownerUpdates: Promise<void> = Promise.resolve();
  private automationDispatch?: (
    scope: WorkspaceExtensionScope,
  ) => AutomationDispatch;

  private automationChanged?: () => void;
  configureAutomations(
    dispatch: (scope: WorkspaceExtensionScope) => AutomationDispatch,
    changed?: () => void,
  ) {
    this.automationChanged = changed;
    this.automationDispatch = dispatch;
  }

  configureOwnerAvailability(
    check: (id: string, root: string) => boolean | Promise<boolean>,
  ) {
    this.ownerAvailable = check;
  }

  needsRestart(id: string) {
    return this.restart.has(id);
  }

  private updateOwner(
    id: string,
    available: (root: string) => boolean | Promise<boolean>,
  ) {
    const update = this.ownerUpdates.then(async () => {
      const results = await Promise.allSettled(
        [...this.workspaces.values()].map(async (entry) => {
          const scope = await entry.pending.catch(() => undefined);
          if (!scope || entry.closing || this.closed) return;
          const enabled = await available(scope.workspaceRoot);
          if (!entry.closing && !this.closed)
            await scope.setOwnerAvailable(
              id,
              enabled && !this.suspended.has(id),
            );
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    this.ownerUpdates = update.catch(() => {});
    return update;
  }

  resumeOwner(id: string) {
    if (this.cleanupBlocked.has(id)) return Promise.resolve();
    this.suspended.delete(id);
    this.restart.delete(id);
    return this.refreshOwner(id).then(() => {
      const definition = this.definitions.find((item) => item.id === id);
      const source = definition && themeSource(definition);
      if (source && this.readyScopes().some((scope) => scope.activation(id))) {
        this.themes.accept(id, source.themes, source.name);
        this.themeOwners.add(id);
      }
    });
  }

  refreshOwner(id: string) {
    return this.updateOwner(id, (root) => this.ownerAvailable(id, root));
  }

  suspendOwner(id: string) {
    const definition = this.definitions.find((item) => item.id === id);
    if (!definition) return Promise.resolve();
    this.suspended.add(id);
    if (
      this.readyScopes().some((scope) =>
        scope
          .externalDiagnostics()
          .some(
            (diagnostic) =>
              diagnostic.id === id && diagnostic.settingsRevision !== undefined,
          ),
      )
    )
      this.restart.add(id);
    this.themes.removeOwner(id);
    this.themeOwners.delete(id);
    for (const { scope } of this.workspaces.values()) scope.abortOwner(id);
    return this.updateOwner(id, () => false).catch((error) => {
      this.restart.add(id);
      this.cleanupBlocked.add(id);
      throw error;
    });
  }
  private definitions: readonly ChiselExtension[];
  private readonly workspaces = new Map<
    string,
    {
      scope: WorkspaceExtensionScope;
      pending: Promise<WorkspaceExtensionScope>;
      workspace: WorkspaceRef;
      closing?: Promise<void>;
    }
  >();
  private closed = false;
  private disposal?: Promise<void>;
  /** Application composition only; pending/closed scopes are never published here. */
  readyScopes(): readonly WorkspaceExtensionScope[] {
    if (this.closed) return [];
    return [...this.workspaces.values()].flatMap(({ scope }) => {
      try {
        scope.assertUsable();
        return [scope];
      } catch {
        return [];
      }
    });
  }
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
    this.definitions = definitions.map((definition) => {
      const resource = applicationResource(definition);
      if (resource) this.applicationResources.add(resource);
      const captured = Object.freeze({
        id: definition.id,
        activate: definition.activate.bind(definition),
      });
      inheritOptional(definition, captured);
      inheritThemeSource(definition, captured);
      if (definition.themes) {
        this.themes.accept(definition.id, definition.themes);
        this.themeOwners.add(definition.id);
      }
      return captured;
    });
  }
  /** Boot identity exists before activation; live UI must not shadow a standard definition. */
  hasDefinition(id: string): boolean {
    return this.definitions.some((definition) => definition.id === id);
  }
  async open(
    root: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceExtensionScope> {
    if (this.closed)
      throw new ExtensionLifecycleError("Extension host is closed.");
    const workspace = await admitWorkspace(root, { signal });
    const canonical = workspace.root;
    if (this.closed)
      throw new ExtensionLifecycleError("Extension host is closed.");
    const existing = this.workspaces.get(canonical);
    if (existing) {
      if (existing.closing) {
        await abortable(() => existing.closing, signal);
        return this.open(canonical, signal);
      }
      const scope = await abortable(() => existing.pending, signal);
      await revalidateWorkspace(existing.workspace, signal);
      scope.assertUsable();
      return scope;
    }
    const scope: WorkspaceExtensionScope = new WorkspaceExtensionScope(
      canonical,
      () => {
        if (this.workspaces.get(canonical)?.scope === scope)
          this.workspaces.delete(canonical);
      },
      this.automationDispatch,
      (id) => !this.suspended.has(id) && this.ownerAvailable(id, canonical),
      this.automationChanged,
    );
    const definitions = this.definitions;
    const pending = Promise.resolve().then(async () => {
      try {
        await scope.activate(
          definitions,
          async (id) =>
            !this.suspended.has(id) &&
            (await this.ownerAvailable(id, canonical)) &&
            !this.suspended.has(id),
        );
        await revalidateWorkspace(workspace);
        if (this.closed)
          throw new ExtensionLifecycleError(
            "Extension host closed during activation.",
          );
        scope.assertUsable();
        for (const definition of definitions) {
          if (this.themeOwners.has(definition.id)) continue;
          const source = themeSource(definition);
          if (
            source &&
            (!optionalDiagnostic(definition, canonical) ||
              optionalDiagnostic(definition, canonical)?.state === "active")
          ) {
            this.themes.accept(definition.id, source.themes, source.name);
            this.themeOwners.add(definition.id);
          }
        }
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
    this.workspaces.set(canonical, { scope, pending, workspace });
    return pending;
  }
  /** Application closes an unused root only after its conversation owners have
   * settled. Other roots keep their services and contributions. */
  async closeWorkspace(root: string): Promise<void> {
    const canonical = await canonicalWorkspaceRoot(root);
    const entry = this.workspaces.get(canonical);
    if (!entry) return;
    entry.closing ??= Promise.resolve().then(async () => {
      entry.scope.abortLifetime();
      await entry.pending.catch(() => {});
      await this.ownerUpdates;
      await entry.scope.dispose();
    });
    await entry.closing;
  }
  abortWorkspaces(): void {
    for (const { scope } of this.workspaces.values()) scope.abortLifetime();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    const entries = [...this.workspaces.values()].reverse();
    this.definitions = [];
    this.disposal = Promise.resolve().then(async () => {
      const failures: CleanupFailure[] = [];
      await this.ownerUpdates;
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
      this.themes.dispose();
      for (const resource of [...this.applicationResources].reverse()) {
        try {
          await resource.dispose(failures.length === 0);
        } catch (error) {
          failures.push(cleanupFailure("external-application", error));
        }
      }
      this.applicationResources.clear();
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
