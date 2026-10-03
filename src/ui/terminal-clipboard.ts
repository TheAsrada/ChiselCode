import {
  type ClipboardService,
  type CliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  EditBufferRenderable,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  type Renderable,
  type Selection,
  stripAnsiSequences,
} from "@opentui/core";

/** Paste stays text, even when the terminal forwards Windows line endings. */
export function clipboardPasteText(bytes: Uint8Array): string {
  const text = stripAnsiSequences(decodePasteBytes(bytes)).replace(
    /\r\n?/g,
    "\n",
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal controls are deliberately removed from pasted text.
  const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
  return text.replace(controls, "");
}

export function remoteClipboardHost(renderer: CliRenderer): boolean {
  return Boolean(
    process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      renderer.capabilities?.remote,
  );
}

/** Native OS clipboard locally; OSC52 writes reach the user's terminal over SSH. */
export function createTerminalClipboard(
  renderer: CliRenderer,
): ClipboardService {
  const adapter = createRendererClipboardAdapter(renderer);
  return createClipboard({
    host: createHostClipboard({
      timeoutMs: 1500,
      maxReadBytes: 4 * 1024 * 1024,
      maxWriteBytes: 4 * 1024 * 1024,
    }),
    terminal: {
      get remote() {
        return remoteClipboardHost(renderer);
      },
      writeText: adapter.writeText,
      clear: adapter.clear,
    },
  });
}

function editorAncestor(
  target: Renderable | null,
): EditBufferRenderable | null {
  for (let current = target; current; current = current.parent)
    if (current instanceof EditBufferRenderable) return current;
  return null;
}

/** One binding per screen tree; fields retain their native paste/selection logic. */
export class TerminalClipboardController {
  private clipboard?: ClipboardService;
  private attached = false;
  private readonly reads = new Set<AbortController>();
  private readonly writes = new Set<AbortController>();
  private writeQueue = Promise.resolve();
  private fallback?: () => EditBufferRenderable | null;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly notice: (message: string) => void,
    private readonly supplied?: ClipboardService,
    private readonly remote = () => remoteClipboardHost(renderer),
  ) {}

  private service(): ClipboardService {
    this.clipboard ??= this.supplied ?? createTerminalClipboard(this.renderer);
    return this.clipboard;
  }

  registerComposer(resolve: () => EditBufferRenderable | null): () => void {
    this.fallback = resolve;
    return () => {
      if (this.fallback === resolve) this.fallback = undefined;
    };
  }

  attach(): () => void {
    this.attached = true;
    this.renderer.keyInput.prependListener("keypress", this.key);
    this.renderer.keyInput.prependListener("paste", this.normalizePaste);
    this.renderer.on("selection", this.selection);
    this.renderer.on("focused_renderable", this.cancelReads);
    this.renderer.on("destroy", this.detach);
    return this.detach;
  }

  private cancelReads = () => {
    for (const read of this.reads) read.abort();
  };

  private detach = () => {
    this.attached = false;
    this.cancelReads();
    for (const write of this.writes) write.abort();
    this.renderer.keyInput.off("keypress", this.key);
    this.renderer.keyInput.off("paste", this.normalizePaste);
    this.renderer.off("selection", this.selection);
    this.renderer.off("focused_renderable", this.cancelReads);
    this.renderer.off("destroy", this.detach);
    const clipboard = this.clipboard;
    this.clipboard = undefined;
    if (clipboard && clipboard !== this.supplied)
      void clipboard.dispose().catch(() => {});
  };

  private normalizePaste = (event: PasteEvent) => {
    if (event.metadata?.kind === "binary") return;
    event.bytes = new TextEncoder().encode(clipboardPasteText(event.bytes));
    if (!this.renderer.currentFocusedEditor) this.fallback?.();
  };

  private key = (key: KeyEvent) => {
    if (key.ctrl && key.name === "c" && !key.shift) {
      this.cancelReads();
      return;
    }
    const copy =
      (key.ctrl && key.shift && key.name === "c") ||
      (key.ctrl && !key.shift && key.name === "insert") ||
      (key.super && key.name === "c");
    const paste =
      (key.ctrl && key.name === "v") ||
      (key.shift && !key.ctrl && key.name === "insert") ||
      (key.super && key.name === "v");
    if (!copy && !paste) return;
    key.preventDefault();
    key.stopPropagation();
    if (copy) this.copy();
    else void this.paste();
  };

  private selection = (selection: Selection) => {
    // Selecting input text must not overwrite what the user intends to paste.
    queueMicrotask(() => {
      if (
        !this.attached ||
        selection !== this.renderer.getSelection() ||
        selection.selectedRenderables.some(
          (renderable) => renderable instanceof EditBufferRenderable,
        )
      )
        return;
      this.copy(false);
    });
  };

  copy(clear = false): void {
    const selection = this.renderer.getSelection();
    const editor = this.renderer.currentFocusedEditor;
    const text = editor?.getSelectedText() || selection?.getSelectedText();
    if (!text) return;
    const abort = new AbortController();
    this.writes.add(abort);
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        if (!this.attached || abort.signal.aborted) return;
        const result = await this.service().writeText(text, {
          destination: "best-available",
          signal: abort.signal,
        });
        if (!this.attached || abort.signal.aborted) return;
        const sent = result.terminal.status === "attempted";
        if (result.host.status === "written")
          this.notice("Скопировано | Ctrl+V вставить");
        else if (sent) this.notice("Выделение передано в буфер терминала");
        else
          this.notice(
            "Не удалось скопировать. Используйте Shift+выделение в терминале.",
          );
        if (
          clear &&
          (result.host.status === "written" || sent) &&
          selection === this.renderer.getSelection() &&
          selection?.getSelectedText() === text
        )
          this.renderer.clearSelection();
      } catch {
        if (this.attached && !abort.signal.aborted)
          this.notice(
            "Не удалось скопировать. Используйте Shift+выделение в терминале.",
          );
      } finally {
        this.writes.delete(abort);
      }
    });
  }

  async paste(target?: EditBufferRenderable | null): Promise<void> {
    if (!this.attached) return;
    const editor =
      target ?? this.renderer.currentFocusedEditor ?? this.fallback?.();
    if (!editor || editor.isDestroyed) return;
    editor.focus();
    if (this.remote()) {
      this.notice("Вставьте через терминал: Ctrl+Shift+V / Shift+Insert");
      return;
    }
    const abort = new AbortController();
    this.reads.add(abort);
    try {
      await this.writeQueue;
      if (abort.signal.aborted) return;
      const result = await this.service().read({
        preferredTypes: ["text/plain;charset=utf-8", "text/plain"],
        signal: abort.signal,
      });
      if (
        !this.attached ||
        abort.signal.aborted ||
        editor.isDestroyed ||
        this.renderer.currentFocusedEditor !== editor
      )
        return;
      if (result.status === "read") {
        this.renderer.keyInput.processPaste(result.representation.bytes, {
          kind: "text",
          mimeType: result.representation.mimeType,
        });
      } else if (result.status === "limit-exceeded")
        this.notice("Текст в буфере слишком большой. Вставьте его частями.");
      else if (result.status !== "empty" && result.status !== "cancelled")
        this.notice(
          "Не удалось прочитать буфер. Попробуйте Ctrl+Shift+V в терминале.",
        );
    } catch {
      if (this.attached && !abort.signal.aborted)
        this.notice(
          "Не удалось прочитать буфер. Попробуйте Ctrl+Shift+V в терминале.",
        );
    } finally {
      this.reads.delete(abort);
    }
  }

  mouseDown = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    const editor = editorAncestor(event.target);
    if (!editor && this.renderer.getSelection()?.getSelectedText())
      this.copy(true);
    else void this.paste(editor);
  };
}
