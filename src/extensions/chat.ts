import {
  type ChatPresentationPort,
  ChatPresentationSchema,
  type ChatStyle,
} from "../types/chat-presentation.js";
import type { ToolExecutionResult } from "../types/domain.js";
import type { Disposable, ExtensionChatView } from "./contracts.js";
import { ExtensionLifecycleError, frozenClone } from "./lifecycle.js";

/** Linked extensions return bounded data; terminal components stay in the UI. */
export class ExtensionChatViews implements ChatPresentationPort {
  private readonly views = new Map<string, (data: unknown) => unknown>();
  private sealed = false;
  private closed = false;
  constructor(private readonly available: () => void) {}
  register(extensionId: string, view: ExtensionChatView): Disposable {
    const key = JSON.stringify([extensionId, view?.id]);
    if (
      this.sealed ||
      this.closed ||
      !view ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(view.id) ||
      typeof view.render !== "function" ||
      this.views.has(key)
    )
      throw new ExtensionLifecycleError(
        "Invalid or duplicate chat view registration.",
        extensionId,
      );
    const render = view.render.bind(view);
    this.views.set(key, render);
    return {
      dispose: () => {
        this.views.delete(key);
      },
    };
  }
  seal(): void {
    this.sealed = true;
  }
  dispose(): void {
    this.closed = true;
    this.views.clear();
  }
  render(extensionId: string, view: string, data: unknown) {
    try {
      if (!this.sealed || this.closed) return undefined;
      this.available();
      const render = this.views.get(JSON.stringify([extensionId, view]));
      if (!render) return undefined;
      // A formatter cannot change a completed tool's output or mutable live state.
      const value = render(frozenClone(data));
      if (value === undefined) return undefined;
      const parsed = ChatPresentationSchema.safeParse(value);
      return parsed.success
        ? frozenClone({ extensionId, view: parsed.data })
        : undefined;
    } catch {
      // Rendering failures cannot turn an executed tool into a failed invocation.
      return undefined;
    }
  }
  result(
    extensionId: string,
    style: ChatStyle | undefined,
    result: ToolExecutionResult,
  ): ToolExecutionResult {
    const { presentation: _unowned, ...content } = result;
    if (!style?.view || content.isError || content.requiresApproval)
      return content;
    const presentation = this.render(extensionId, style.view, content);
    return presentation ? { ...content, presentation } : content;
  }
}
