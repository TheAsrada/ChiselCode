import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { SecretRedactor } from "../security/redaction.js";
import type { Disposable } from "./contracts.js";
import {
  abortable,
  ExtensionLifecycleError,
  frozenClone,
} from "./lifecycle.js";
import { coreUiTarget } from "./ui-core.js";
import {
  type OwnedUiContribution,
  type UiAction,
  type UiActionUse,
  type UiBinding,
  type UiContribution,
  type UiDetailsPage,
  UiDetailsPageSchema,
  type UiDetailsView,
  UiIdSchema,
  type UiSnapshot,
  UiSnapshotSchema,
} from "./ui-types.js";

const metadata = z
  .object({
    id: UiIdSchema,
    slot: z.enum(["status", "context_section", "menu_entry"]),
    scope: z.enum(["workspace", "conversation"]),
    title: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    group: z.enum(["conversation", "project", "extensions"]).optional(),
    shortcut: z.string().max(40).optional(),
    order: z.number().int().min(0).max(100).optional(),
  })
  .strict();
const viewMetadata = z
  .object({
    id: UiIdSchema,
    scope: z.enum(["workspace", "conversation"]),
    title: z.string().min(1).max(120),
  })
  .strict();
type Entry = {
  extensionId: string;
  descriptor: OwnedUiContribution["descriptor"];
  actions: readonly UiAction[];
  source: UiContribution["source"];
};
type View = {
  extensionId: string;
  descriptor: z.infer<typeof viewMetadata>;
  actions: readonly UiAction[];
  page: UiDetailsView["page"];
  subscribe?: UiDetailsView["subscribe"];
};

/** Bounded plain DTOs, sanitized before publication or caching. */
export function sanitizeUi<T>(
  schema: z.ZodType<T>,
  input: unknown,
  redactor = new SecretRedactor(),
  budget = 65536,
): T {
  // Reject before recursively cloning a caller's arbitrarily large tree.
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > budget)
    throw new Error("UI data limit exceeded.");
  schema.parse(input);
  const clean = (value: unknown): unknown => {
    if (typeof value === "string")
      return stripVTControlCharacters(
        redactor
          .text(value)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove complete and unfinished OSC payloads before storage.
          .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, ""),
      ).replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : " "));
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, clean(child)]),
      );
    return value;
  };
  const result = schema.parse(clean(redactor.value(JSON.parse(serialized))));
  if (Buffer.byteLength(JSON.stringify(result)) > budget)
    throw new Error("Sanitized UI data limit exceeded.");
  return frozenClone(result);
}
function captureActions(
  actions: readonly UiAction[] = [],
): readonly UiAction[] {
  if (actions.length > 8) throw new Error("Too many UI actions.");
  const ids = new Set<string>();
  return Object.freeze(
    actions.map((action) => {
      const allowed =
        action.type === "view"
          ? ["id", "label", "type", "viewId"]
          : action.type === "tool"
            ? ["id", "label", "type", "tool"]
            : ["id", "label", "type", "target"];
      if (Object.keys(action).some((key) => !allowed.includes(key)))
        throw new Error("Unknown UI action metadata.");
      const id = UiIdSchema.parse(action.id);
      const label = sanitizeUi(z.string().min(1).max(120), action.label);
      if (ids.has(id)) throw new Error("Duplicate UI action.");
      ids.add(id);
      if (action.type === "view")
        return Object.freeze({
          id,
          label,
          type: action.type,
          viewId: UiIdSchema.parse(action.viewId),
        });
      if (action.type === "tool")
        return Object.freeze({
          id,
          label,
          type: action.type,
          tool: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,63}$/)
            .parse(action.tool),
        });
      if (action.type === "core" && coreUiTarget(action.target))
        return Object.freeze({
          id,
          label,
          type: action.type,
          target: action.target,
        });
      throw new Error("UI action is not attested.");
    }),
  );
}

/** Staged workspace registry, owned by the existing host lifecycle. */
export class ExtensionUiRegistry implements Disposable {
  readonly instance = randomUUID();
  get signal(): AbortSignal {
    return this.lifetime;
  }
  private entries = new Map<string, Entry>();
  private views = new Map<string, View>();
  private bindings = new Set<UiSubscription>();
  private sealed = false;
  private closed = false;
  constructor(
    readonly workspaceRoot: string,
    private lifetime: AbortSignal,
    private available: () => void,
    private commandOwner?: (name: string) => string | undefined,
    private ownsTool?: (extensionId: string, name: string) => boolean,
  ) {}
  register(extensionId: string, contribution: UiContribution): Disposable {
    return this.stage(
      extensionId,
      contribution.id,
      this.entries,
      12,
      64,
      () => {
        const { source, actions, ...descriptor } = contribution;
        if (
          typeof source?.snapshot !== "function" ||
          (source.subscribe && typeof source.subscribe !== "function")
        )
          throw new Error("Invalid UI source.");
        return {
          extensionId,
          descriptor: sanitizeUi(metadata, descriptor),
          actions: captureActions(actions),
          source: Object.freeze({
            snapshot: source.snapshot.bind(source),
            ...(source.subscribe
              ? { subscribe: source.subscribe.bind(source) }
              : {}),
          }),
        };
      },
    );
  }
  registerView(extensionId: string, view: UiDetailsView): Disposable {
    return this.stage(extensionId, view.id, this.views, 8, 32, () => {
      const { page, subscribe, actions, ...descriptor } = view;
      if (
        typeof page !== "function" ||
        (subscribe && typeof subscribe !== "function")
      )
        throw new Error("Invalid UI view.");
      return {
        extensionId,
        descriptor: sanitizeUi(viewMetadata, descriptor),
        actions: captureActions(actions),
        page: page.bind(view),
        ...(subscribe ? { subscribe: subscribe.bind(view) } : {}),
      };
    });
  }
  private stage<T extends { extensionId: string }>(
    owner: string,
    id: string,
    map: Map<string, T>,
    ownLimit: number,
    totalLimit: number,
    capture: () => T,
  ): Disposable {
    if (this.sealed || this.closed || this.lifetime.aborted)
      throw new ExtensionLifecycleError("UI registrations are closed.", owner);
    try {
      UiIdSchema.parse(id);
      const key = `${owner}/${id}`;
      if (
        map.has(key) ||
        map.size >= totalLimit ||
        [...map.values()].filter((item) => item.extensionId === owner).length >=
          ownLimit
      )
        throw new Error("Duplicate UI identity or registration limit.");
      map.set(key, Object.freeze(capture()));
      return {
        dispose: () => {
          map.delete(key);
        },
      };
    } catch (cause) {
      throw new ExtensionLifecycleError(
        "Invalid UI registration.",
        owner,
        cause,
      );
    }
  }
  seal(): void {
    for (const entry of [...this.entries.values(), ...this.views.values()])
      for (const action of entry.actions)
        if (
          action.type === "view" &&
          !this.views.has(`${entry.extensionId}/${action.viewId}`)
        )
          throw new ExtensionLifecycleError(
            "UI view is not registered.",
            entry.extensionId,
          );
    for (const entry of [...this.entries.values(), ...this.views.values()])
      for (const action of entry.actions)
        if (
          action.type === "tool" &&
          this.ownsTool &&
          !this.ownsTool(entry.extensionId, action.tool)
        )
          throw new ExtensionLifecycleError(
            "UI tool is not registered by its owner.",
            entry.extensionId,
          );
    for (const entry of this.entries.values()) {
      const shortcut = entry.descriptor.shortcut;
      if (!shortcut) continue;
      const valid = shortcut.startsWith("/")
        ? this.commandOwner?.(shortcut.slice(1)) === entry.extensionId
        : shortcut === "F7" &&
          entry.actions.some(
            (action) =>
              action.type === "core" &&
              coreUiTarget(action.target) === "agents",
          );
      if (!valid)
        throw new ExtensionLifecycleError(
          "UI shortcut is not owned or attested.",
          entry.extensionId,
        );
    }
    this.sealed = true;
  }
  assertAvailable(): void {
    if (!this.sealed || this.closed || this.lifetime.aborted)
      throw new ExtensionLifecycleError("UI workspace is unavailable.");
    this.available();
  }
  descriptors(): readonly Readonly<Entry>[] {
    this.assertAvailable();
    return [...this.entries.values()].sort(
      (a, b) =>
        (a.descriptor.order ?? 50) - (b.descriptor.order ?? 50) ||
        a.extensionId.localeCompare(b.extensionId) ||
        a.descriptor.id.localeCompare(b.descriptor.id),
    );
  }
  bind(
    binding: Omit<UiBinding, "workspaceRoot" | "scopeInstance">,
    changed: (items: readonly OwnedUiContribution[]) => void,
    redactor?: SecretRedactor,
  ): UiSubscription {
    this.assertAvailable();
    const subscription = new UiSubscription(
      this,
      binding,
      changed,
      redactor,
      () => this.bindings.delete(subscription),
    );
    this.bindings.add(subscription);
    subscription.start();
    return subscription;
  }
  view(key: string): Readonly<View> | undefined {
    this.assertAvailable();
    return this.views.get(key);
  }
  entry(key: string): Readonly<Entry> | undefined {
    this.assertAvailable();
    return this.entries.get(key);
  }
  dispose(): void {
    this.closed = true;
    for (const binding of this.bindings) binding.dispose();
    this.bindings.clear();
    this.entries.clear();
    this.views.clear();
  }
}

/** One live view owner. Late results never cross binding or scope instances. */
export class UiSubscription implements Disposable {
  readonly binding: UiBinding;
  private abort = new AbortController();
  private cache = new Map<string, OwnedUiContribution>();
  private resources: Disposable[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private reading = new Set<string>();
  private dirty = new Set<string>();
  private disposed = false;
  private requestSerial = new Map<string, number>();
  private revisions = new Map<string, number>();
  private viewRevisions = new Map<string, number>();
  constructor(
    private registry: ExtensionUiRegistry,
    binding: Omit<UiBinding, "workspaceRoot" | "scopeInstance">,
    private changed: (items: readonly OwnedUiContribution[]) => void,
    private redactor = new SecretRedactor(),
    private onDispose: () => void = () => {},
  ) {
    const read = Object.freeze({
      ownerSummary: () => frozenClone(binding.read.ownerSummary()),
      subscribeOwner: binding.read.subscribeOwner.bind(binding.read),
    });
    this.binding = Object.freeze({
      ...binding,
      read,
      workspaceRoot: registry.workspaceRoot,
      scopeInstance: registry.instance,
      signal: AbortSignal.any([
        binding.signal,
        this.abort.signal,
        registry.signal,
      ]),
    });
  }
  start(): void {
    this.binding.signal.addEventListener("abort", this.close, { once: true });
    for (const entry of this.registry.descriptors()) {
      const key = `${entry.extensionId}/${entry.descriptor.id}`;
      this.cache.set(
        key,
        frozenClone({
          key,
          extensionId: entry.extensionId,
          descriptor: entry.descriptor,
          snapshot: { revision: 0, state: "loading" },
        }),
      );
      if (
        entry.descriptor.scope === "conversation" &&
        !this.binding.conversationId
      )
        continue;
      try {
        if (entry.source.subscribe) {
          const resource = entry.source.subscribe(
            this.sourceBinding(entry.descriptor.scope),
            () => this.refresh(key),
          );
          if (!resource || typeof resource.dispose !== "function")
            throw new Error("Invalid UI subscription.");
          this.resources.push(resource);
        }
      } catch {
        this.unavailable(key);
        continue;
      }
      this.refresh(key, true);
    }
    this.publish();
  }
  private sourceBinding(scope: "workspace" | "conversation"): UiBinding {
    if (scope === "conversation") return this.binding;
    return Object.freeze({
      ...this.binding,
      conversationId: undefined,
      sessionId: undefined,
      read: Object.freeze({
        ownerSummary: () => ({
          background: { active: 0, errors: 0, awaitingApproval: 0 },
          agents: { active: 0, total: 0, errors: 0 },
        }),
        subscribeOwner: () => ({ dispose() {} }),
      }),
    });
  }
  get items(): readonly OwnedUiContribution[] {
    return [...this.cache.values()];
  }
  isLive(): boolean {
    return !this.disposed && !this.binding.signal.aborted;
  }
  private close = () => this.dispose();
  private publish(): void {
    if (this.isLive()) this.changed(Object.freeze(this.items));
  }
  private unavailable(key: string): void {
    const current = this.cache.get(key);
    if (current)
      this.cache.set(
        key,
        frozenClone({
          ...current,
          snapshot: {
            revision: current.snapshot.revision,
            state: "unavailable",
            label: "Данные недоступны",
            tone: "warning",
          },
        }),
      );
    this.publish();
  }
  refresh(key?: string, immediate = false): void {
    if (!this.isLive()) return;
    if (!key) {
      for (const id of this.cache.keys()) this.refresh(id);
      return;
    }
    if (this.reading.has(key)) {
      this.dirty.add(key);
      return;
    }
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(
        () => {
          this.timers.delete(key);
          void this.acquire(key);
        },
        immediate ? 0 : 100,
      ),
    );
  }
  private async acquire(key: string): Promise<void> {
    if (!this.isLive()) return;
    this.reading.add(key);
    const serial = (this.requestSerial.get(key) ?? 0) + 1;
    this.requestSerial.set(key, serial);
    try {
      const entry = this.registry.entry(key);
      if (!entry) return;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 2000);
      const binding = Object.freeze({
        ...this.sourceBinding(entry.descriptor.scope),
        signal: AbortSignal.any([this.binding.signal, timeout.signal]),
      });
      let snapshot: UiSnapshot;
      try {
        snapshot = sanitizeUi(
          UiSnapshotSchema,
          await abortable(() => entry.source.snapshot(binding), binding.signal),
          this.redactor,
        );
      } finally {
        clearTimeout(timer);
      }
      for (const use of [
        snapshot.action,
        ...(snapshot.rows ?? []).map((row) => row.action),
      ])
        if (use && !entry.actions.some((action) => action.id === use.id))
          throw new Error("Unknown UI source action.");
      const previousRevision = this.revisions.get(key);
      if (
        !this.isLive() ||
        serial !== this.requestSerial.get(key) ||
        (previousRevision !== undefined &&
          snapshot.revision <= previousRevision)
      )
        return;
      this.revisions.set(key, snapshot.revision);
      this.cache.set(
        key,
        frozenClone({
          key,
          extensionId: entry.extensionId,
          descriptor: entry.descriptor,
          snapshot,
        }),
      );
      this.publish();
    } catch {
      if (this.isLive()) this.unavailable(key);
    } finally {
      this.reading.delete(key);
      if (this.dirty.delete(key)) this.refresh(key);
    }
  }
  /** A validated live action plan; it carries no serialized execution authority. */
  action(
    key: string,
    use: UiActionUse,
    revision: number,
    fromView = false,
  ): UiAction | undefined {
    if (!this.isLive()) return;
    this.registry.assertAvailable();
    const entry = fromView ? this.registry.view(key) : this.registry.entry(key);
    if (
      !entry ||
      (!fromView && this.cache.get(key)?.snapshot.revision !== revision)
    )
      return;
    return entry.actions.find((action) => action.id === use.id);
  }
  async page(
    key: string,
    request: Readonly<{ cursor?: string; search?: string }> = {},
    operation?: AbortSignal,
  ): Promise<UiDetailsPage> {
    if (!this.isLive()) throw new Error("Представление закрыто.");
    const view = this.registry.view(key);
    if (!view)
      return {
        revision: 0,
        state: "unavailable",
        summary: "Представление недоступно",
      };
    const captured = frozenClone(
      z
        .object({
          cursor: z.string().max(120).optional(),
          search: z.string().max(120).optional(),
        })
        .strict()
        .parse(request),
    );
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 2000);
    const binding = Object.freeze({
      ...this.sourceBinding(view.descriptor.scope),
      signal: AbortSignal.any([
        this.binding.signal,
        timeout.signal,
        ...(operation ? [operation] : []),
      ]),
    });
    try {
      const page = sanitizeUi(
        UiDetailsPageSchema,
        await abortable(() => view.page(binding, captured), binding.signal),
        this.redactor,
      );
      for (const use of [
        ...(page.actions ?? []),
        ...(page.rows ?? []).flatMap((row) => (row.action ? [row.action] : [])),
      ])
        if (!view.actions.some((action) => action.id === use.id))
          throw new Error("Unknown UI view action.");
      const previous = this.viewRevisions.get(key);
      if (previous !== undefined && page.revision < previous)
        throw new Error("Stale UI page.");
      this.viewRevisions.set(key, page.revision);
      return page;
    } catch {
      return {
        revision: 0,
        state: "unavailable",
        summary: "Данные недоступны. Повторите получение.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  viewDescriptor(key: string) {
    return this.registry.view(key)?.descriptor;
  }
  subscribeView(key: string, changed: () => void): Disposable {
    const view = this.registry.view(key);
    if (!view?.subscribe || !this.isLive()) return { dispose() {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const resource = view.subscribe(
      this.sourceBinding(view.descriptor.scope),
      () => {
        if (closed || timer || !this.isLive()) return;
        timer = setTimeout(() => {
          timer = undefined;
          if (!closed && this.isLive()) changed();
        }, 100);
      },
    );
    if (!resource || typeof resource.dispose !== "function")
      throw new Error("Invalid UI view subscription.");
    const subscription = {
      dispose: () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        const index = this.resources.indexOf(subscription);
        if (index >= 0) this.resources.splice(index, 1);
        return resource.dispose();
      },
    };
    this.resources.push(subscription);
    return subscription;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.binding.signal.removeEventListener("abort", this.close);
    this.abort.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const resource of [...this.resources].reverse()) {
      try {
        void Promise.resolve(resource.dispose()).catch(() => {});
      } catch {
        /* Other sources still unsubscribe. */
      }
    }
    this.resources.length = 0;
    this.timers.clear();
    this.cache.clear();
    this.onDispose();
  }
}
