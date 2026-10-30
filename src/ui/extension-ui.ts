import { backgroundActive } from "../background/contracts.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { frozenClone } from "../extensions/lifecycle.js";
import { coreUiTarget } from "../extensions/ui-core.js";
import {
  type UiActionUse,
  UiActionUseSchema,
  type UiDetailsPage,
  type UiOwnerSummary,
  uiNodeInfo,
} from "../extensions/ui-types.js";
import type { SecretRedactor } from "../security/redaction.js";
import { subagentActive } from "../subagents/contracts.js";
import type { ChatCard } from "../types/chat-presentation.js";
import type { JsonObject, ToolExecutionResult } from "../types/domain.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";
import { UiSubscriptions } from "./ui-subscriptions.js";

export type UiToolSubmit = (
  controller: TuiController,
  scope: WorkspaceExtensionScope,
  extensionId: string,
  tool: string,
  args: JsonObject,
  toolScope?: WorkspaceExtensionScope,
) => Promise<ToolExecutionResult>;
export interface ExtensionDetailsState {
  key: string;
  title: string;
  extensionId: string;
  loading: boolean;
  page?: Readonly<UiDetailsPage>;
  selected?: string;
  cursor?: string;
  search?: string;
  notice?: string;
}

const externalNotices = new WeakMap<TuiController, Set<string>>();
/** Application adapter: the registry and linked code never receive a controller. */
export class ExtensionUiBinding {
  readonly subscription: UiSubscriptions;
  private pending = new Set<string>();
  private serial = 0;
  private closed = false;
  private viewSubscription?: { dispose(): void | Promise<void> };
  private pageAbort?: AbortController;
  private returnFocus: TuiController["snapshot"]["focus"] = "composer";
  private generation: number;
  constructor(
    readonly controller: TuiController,
    readonly scope: WorkspaceExtensionScope,
    private submit?: UiToolSubmit,
    redactor?: SecretRedactor,
    additionalScopes: readonly WorkspaceExtensionScope[] = [],
  ) {
    this.generation = controller.currentGeneration;
    const notices = externalNotices.get(controller) ?? new Set<string>();
    externalNotices.set(controller, notices);
    for (const diagnostic of scope.externalDiagnostics()) {
      if (
        ![
          "invalid",
          "modified",
          "incompatible",
          "load_failed",
          "activation_failed",
          "cleanup_failed",
        ].includes(diagnostic.state)
      )
        continue;
      const key = `${scope.workspaceRoot}/${diagnostic.id}`;
      if (notices.has(key)) continue;
      notices.add(key);
      controller.appendNotice(
        `Расширение ${diagnostic.name ?? diagnostic.id}: ${diagnostic.reason ?? "данные недоступны"} Встроенные возможности доступны.`,
        "error",
      );
    }
    const ownerSummary = (): UiOwnerSummary => {
      const tasks = (controller.snapshot.backgroundTasks ?? []).filter(
        (task) => !task.foreground,
      );
      const children = controller.snapshot.children ?? [];
      return {
        background: {
          active: tasks.filter((task) => backgroundActive(task.state)).length,
          errors: tasks.filter((task) =>
            [
              "failed",
              "cleanup_unknown",
              "lost",
              "output_limit",
              "start_failed",
              "timed_out",
              "denied",
              "interrupted",
            ].includes(task.state),
          ).length,
          awaitingApproval: tasks.filter(
            (task) => task.state === "awaiting_approval",
          ).length,
        },
        agents: {
          active: children.filter((child) => subagentActive(child.status))
            .length,
          total: children.length,
          errors: children.filter((child) =>
            [
              "failed",
              "interrupted",
              "timed_out",
              "budget_exhausted",
              "approval_unavailable",
            ].includes(child.status),
          ).length,
        },
      };
    };
    this.subscription = new UiSubscriptions(
      [scope, ...additionalScopes],
      {
        conversationId: controller.conversationId,
        sessionId: controller.snapshot.sessionId,
        generation: this.generation,
        signal: controller.ownerSignal,
        read: {
          ownerSummary,
          subscribeOwner: (changed) => {
            let previous = JSON.stringify(ownerSummary());
            const detach = controller.subscribe(() => {
              const current = JSON.stringify(ownerSummary());
              if (current !== previous) {
                previous = current;
                changed();
              }
            });
            return { dispose: detach };
          },
        },
      },
      (items) => controller.setUiContributions(items),
      redactor,
    );
  }
  private live(): boolean {
    return (
      !this.closed &&
      this.subscription.isLive() &&
      this.controller.isCurrent(this.generation)
    );
  }
  refresh(): void {
    this.subscription.refresh();
  }
  async event(
    key: string,
    nodeKey: string,
    event: unknown,
    revision: number,
    presentation?: import("../extension-sdk/ui-composition.js").UiPresentationContext,
  ) {
    if (!this.live()) return;
    try {
      await this.subscription.event(
        key,
        nodeKey,
        event,
        revision,
        presentation,
      );
    } catch {
      if (this.live())
        this.controller.setExtensionNotice(
          "Обработчик интерфейса завершился с ошибкой.",
        );
    }
  }
  async dispatch(
    key: string,
    raw: UiActionUse,
    revision: number,
    fromView = false,
    presentation?: import("../extension-sdk/ui-composition.js").UiPresentationContext,
  ): Promise<void> {
    if (!this.live()) return;
    const use = frozenClone(UiActionUseSchema.parse(raw));
    if (Buffer.byteLength(JSON.stringify(use)) > 8192) return;
    const snapshot = this.subscription.items.find(
      (item) => item.key === key,
    )?.snapshot;
    const page =
      this.controller.snapshot.extensionView?.key === key
        ? this.controller.snapshot.extensionView.page
        : undefined;
    if (
      fromView ? page?.revision !== revision : snapshot?.revision !== revision
    )
      return;
    const candidates = fromView
      ? [
          ...(page?.actions ?? []),
          ...(page?.rows ?? []).flatMap((row) =>
            row.action ? [row.action] : [],
          ),
        ]
      : [
          snapshot?.action,
          ...(snapshot?.rows ?? []).map((row) => row.action),
          ...uiNodeInfo(snapshot?.render?.content).actions,
        ];
    if (
      !candidates.some(
        (candidate) =>
          candidate && JSON.stringify(candidate) === JSON.stringify(use),
      )
    )
      return;
    const action = this.subscription.action(key, use, revision, fromView);
    if (!action) {
      this.controller.setExtensionNotice("Действие устарело или недоступно.");
      return;
    }
    const extensionId = key.slice(0, key.lastIndexOf("/"));
    const identity = `${key}/${use.id}/${JSON.stringify(use.args ?? {})}`;
    if (this.pending.has(identity)) return;
    this.pending.add(identity);
    try {
      if (action.type === "event")
        await this.subscription.invoke(
          key,
          action.eventId,
          use.args ?? {},
          presentation,
        );
      else if (action.type === "view")
        await this.open(`${extensionId}/${action.viewId}`);
      else if (action.type === "core") {
        const target = coreUiTarget(action.target);
        if (this.controller.snapshot.extensionView) this.close();
        const adapters = {
          background: () => this.controller.showBackground(),
          agents: () => {
            this.controller.setAgentSidebar("agents", true);
            this.controller.setFocus("sidebar");
          },
        };
        if (target && this.live()) adapters[target]();
      } else if (this.submit) {
        if (JSON.stringify(use.args ?? {}).includes("[секрет скрыт]")) {
          this.controller.setExtensionNotice(
            "Аргументы содержат скрытый секрет. Выполните действие через обычный ввод команды.",
          );
          return;
        }
        // Once accepted into the ordinary owner queue, closing this view is not cancellation.
        const result = await this.submit(
          this.controller,
          this.scope,
          extensionId,
          action.tool,
          use.args ?? {},
          this.subscription.scopeFor(key),
        );
        if (this.live() && this.controller.snapshot.extensionView?.key === key)
          this.controller.setExtensionNotice(
            result.isError
              ? "Действие завершилось с ошибкой. Итог сохранён в чате."
              : "Действие выполнено. Итог сохранён в чате.",
          );
      } else
        this.controller.setExtensionNotice("Выполнение действия недоступно.");
    } catch {
      if (this.live())
        this.controller.setExtensionNotice(
          "Не удалось выполнить действие. Проверьте разрешения и доступность возможности.",
        );
    } finally {
      this.pending.delete(identity);
    }
  }
  async open(key: string): Promise<void> {
    if (!this.live()) return;
    const descriptor = this.subscription.viewDescriptor(key);
    void this.viewSubscription?.dispose();
    if (!this.controller.snapshot.extensionView)
      this.returnFocus = this.controller.snapshot.focus;
    this.controller.setExtensionView({
      key,
      extensionId: key.slice(0, key.lastIndexOf("/")),
      title: descriptor?.title ?? "Подробности",
      loading: true,
    });
    this.controller.setFocus("modal");
    try {
      this.viewSubscription = this.subscription.subscribeView(key, () => {
        void this.loadPage(this.controller.snapshot.extensionView?.cursor);
      });
    } catch {
      this.controller.setExtensionView({
        key,
        extensionId: key.slice(0, key.lastIndexOf("/")),
        title: descriptor?.title ?? "Подробности",
        loading: false,
        page: {
          revision: 0,
          state: "unavailable",
          summary: "Данные недоступны. Повторите получение.",
        },
      });
      return;
    }
    const preference = this.controller.uiPresentation.get(key);
    await this.loadPage(preference?.cursor, preference?.search);
  }
  async loadPage(
    cursor?: string,
    search = this.controller.snapshot.extensionView?.search,
  ): Promise<void> {
    const current = this.controller.snapshot.extensionView;
    if (!current || !this.live()) return;
    const serial = ++this.serial;
    this.pageAbort?.abort();
    const pageAbort = new AbortController();
    this.pageAbort = pageAbort;
    const key = current.key;
    this.controller.setExtensionView({
      ...current,
      loading: true,
      cursor,
      search,
    });
    const page = await this.subscription.page(
      key,
      {
        ...(cursor ? { cursor } : {}),
        ...(search ? { search } : {}),
      },
      pageAbort.signal,
    );
    if (
      !this.live() ||
      serial !== this.serial ||
      this.controller.snapshot.extensionView?.key !== key
    )
      return;
    const selected =
      this.controller.uiPresentation.get(key)?.selected ?? current.selected;
    this.controller.uiPresentation.set(key, {
      ...this.controller.uiPresentation.get(key),
      cursor,
      search,
    });
    this.controller.setExtensionView({
      ...current,
      loading: false,
      cursor,
      search,
      page,
      selected: page.rows?.some((row) => row.id === selected)
        ? selected
        : page.rows?.[0]?.id,
    });
  }
  select(id: string): void {
    const current = this.controller.snapshot.extensionView;
    if (!current?.page?.rows?.some((row) => row.id === id)) return;
    if (
      this.controller.uiPresentation.size >= 32 &&
      !this.controller.uiPresentation.has(current.key)
    )
      this.controller.uiPresentation.delete(
        this.controller.uiPresentation.keys().next().value!,
      );
    this.controller.uiPresentation.set(current.key, {
      ...this.controller.uiPresentation.get(current.key),
      selected: id,
    });
    this.controller.setExtensionView({ ...current, selected: id });
  }
  close(): void {
    ++this.serial;
    this.pageAbort?.abort();
    void this.viewSubscription?.dispose();
    this.viewSubscription = undefined;
    this.controller.setExtensionView();
    this.controller.setFocus(this.returnFocus);
  }
  /** Chat controls use the same captured owner adapter, never a restored UUID as authority. */
  async chat(
    target: NonNullable<ChatCard["target"]>,
    action: "open" | "promote" | "stop" | "wait" = "open",
    extensionId?: string,
  ): Promise<void> {
    if (!this.live()) return;
    if (target.type === "extension_view") {
      if (action === "open" && extensionId)
        await this.open(`${extensionId}/${target.viewId}`);
      return;
    }
    await dispatchCoreChat(this.controller, target, action);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.pageAbort?.abort();
    ++this.serial;
    void this.viewSubscription?.dispose();
    this.subscription.dispose();
    if (this.controller.isCurrent(this.generation)) {
      this.controller.setUiContributions([]);
      if (this.controller.snapshot.extensionView) {
        this.controller.setExtensionView();
        this.controller.setFocus(this.returnFocus);
      }
    }
  }
}

/** Shared core navigation path also supports readable archived cards without a formatter. */
export async function dispatchCoreChat(
  controller: TuiController,
  target: NonNullable<ChatCard["target"]>,
  action: "open" | "promote" | "stop" | "wait" = "open",
): Promise<void> {
  if (controller.ownerSignal.aborted) return;
  if (target.type === "subagent") {
    if (action === "open") controller.openAgent(target.id);
  } else if (target.type === "background_task") {
    const adapters = {
      open: () => controller.openBackground(target.id),
      promote: () => controller.promoteBackground(target.id),
      stop: () => controller.stopBackground(target.id),
      wait: () => controller.waitBackground(target.id),
    };
    await adapters[action]();
  }
}
