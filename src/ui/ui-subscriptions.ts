import type { WorkspaceExtensionScope } from "../extensions/host.js";
import type { UiSubscription } from "../extensions/ui.js";
import type {
  OwnedUiContribution,
  UiActionUse,
  UiBinding,
} from "../extensions/ui-types.js";
import type { SecretRedactor } from "../security/redaction.js";

/** Merge UI lifecycles by owned identity; runtime tools keep their original scope. */
export class UiSubscriptions {
  private sources: {
    scope: WorkspaceExtensionScope;
    subscription: UiSubscription;
  }[] = [];
  constructor(
    scopes: readonly WorkspaceExtensionScope[],
    binding: Omit<UiBinding, "workspaceRoot" | "scopeInstance">,
    changed: (items: readonly OwnedUiContribution[]) => void,
    redactor?: SecretRedactor,
  ) {
    try {
      for (const scope of scopes) {
        const subscription = scope.ui.bind(
          binding,
          () => changed(this.items),
          redactor,
        );
        this.sources.push({ scope, subscription });
      }
      changed(this.items);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  get items() {
    return this.sources
      .filter((source) => source.subscription.isLive())
      .flatMap((source) => source.subscription.items)
      .sort(
        (a, b) =>
          (a.descriptor.order ?? 50) - (b.descriptor.order ?? 50) ||
          a.extensionId.localeCompare(b.extensionId) ||
          a.descriptor.id.localeCompare(b.descriptor.id),
      );
  }
  private source(key: string) {
    return this.sources.find(
      (source) =>
        source.subscription.isLive() &&
        (source.subscription.items.some((item) => item.key === key) ||
          source.subscription.viewDescriptor(key)),
    );
  }
  scopeFor(key: string) {
    return this.source(key)?.scope;
  }
  isLive() {
    return !!this.sources[0]?.subscription.isLive();
  }
  refresh() {
    for (const source of this.sources) source.subscription.refresh();
  }
  action(key: string, use: UiActionUse, revision: number, fromView = false) {
    return this.source(key)?.subscription.action(key, use, revision, fromView);
  }
  viewDescriptor(key: string) {
    return this.source(key)?.subscription.viewDescriptor(key);
  }
  subscribeView(key: string, changed: () => void) {
    return (
      this.source(key)?.subscription.subscribeView(key, changed) ?? {
        dispose() {},
      }
    );
  }
  async page(
    key: string,
    request: Readonly<{ cursor?: string; search?: string }>,
    signal?: AbortSignal,
  ) {
    const subscription = this.source(key)?.subscription;
    if (!subscription) throw new Error("Представление закрыто.");
    return subscription.page(key, request, signal);
  }
  dispose() {
    for (const source of this.sources) source.subscription.dispose();
    this.sources = [];
  }
}
