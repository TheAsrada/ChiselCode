import { execFile } from "node:child_process";

/** Read only on an explicit paste gesture; never route clipboard text to a shell. */
export function readWindowsClipboard(): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve("");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $text = Get-Clipboard -Raw; if ($null -ne $text) { [Console]::Write($text) }",
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 20_000_000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Native Windows clipboard observation for terminal-owned mouse selection. */
export function copiedCharactersNotice(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  const suffix =
    tens >= 11 && tens <= 14
      ? "символов"
      : ones === 1
        ? "символ"
        : ones >= 2 && ones <= 4
          ? "символа"
          : "символов";
  return `Скопировано ${count} ${suffix}`;
}

export async function watchWindowsClipboard(
  onCopy: (characters: number) => void,
): Promise<() => void> {
  if (process.platform !== "win32" || !process.stdout.isTTY) return () => {};
  const { dlopen, toArrayBuffer } = await import("bun:ffi");
  const user = dlopen("user32.dll", {
    GetClipboardSequenceNumber: { args: [], returns: "u32" },
    OpenClipboard: { args: ["ptr"], returns: "i32" },
    CloseClipboard: { args: [], returns: "i32" },
    GetClipboardData: { args: ["u32"], returns: "ptr" },
  });
  const kernel = dlopen("kernel32.dll", {
    GlobalLock: { args: ["ptr"], returns: "ptr" },
    GlobalUnlock: { args: ["ptr"], returns: "i32" },
    GlobalSize: { args: ["ptr"], returns: "u64" },
  });
  let lastSequence = user.symbols.GetClipboardSequenceNumber();
  const timer = setInterval(() => {
    try {
      const sequence = user.symbols.GetClipboardSequenceNumber();
      if (!sequence || sequence === lastSequence) return;
      if (!user.symbols.OpenClipboard(null)) return;
      try {
        // CF_UNICODETEXT. A failed/locked clipboard can be retried next tick.
        const handle = user.symbols.GetClipboardData(13);
        if (!handle) {
          lastSequence = sequence;
          return;
        }
        const byteLength = Number(kernel.symbols.GlobalSize(handle));
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength < 2 ||
          byteLength > 20_000_000
        ) {
          lastSequence = sequence;
          return;
        }
        const pointer = kernel.symbols.GlobalLock(handle);
        if (!pointer) return;
        try {
          const bytes = toArrayBuffer(pointer, 0, byteLength);
          const value =
            new TextDecoder("utf-16le").decode(bytes).split("\0", 1)[0] ?? "";
          lastSequence = sequence;
          if (value) onCopy([...value].length);
        } finally {
          kernel.symbols.GlobalUnlock(handle);
        }
      } finally {
        user.symbols.CloseClipboard();
      }
    } catch {
      // Clipboard access is best effort; transient locks must not stop input.
    }
  }, 250);
  timer.unref();
  return () => {
    clearInterval(timer);
    user.close();
    kernel.close();
  };
}

/** Bun raw mode disables QuickEdit in classic conhost; restore mouse selection. */
export async function createWindowsConsoleSelectionGuard(
  captureMouse = false,
): Promise<{
  ensure(): void;
  close(): void;
}> {
  if (process.platform !== "win32" || !process.stdin.isTTY)
    return { ensure() {}, close() {} };
  const { dlopen } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
  });
  const originalMode = new Uint32Array(1);
  const originalHandle = kernel.symbols.GetStdHandle(-10);
  const canRestore =
    !!originalHandle &&
    !!kernel.symbols.GetConsoleMode(originalHandle, originalMode);
  let closed = false;
  return {
    ensure() {
      if (closed) return;
      const handle = kernel.symbols.GetStdHandle(-10);
      const mode = new Uint32Array(1);
      if (handle && kernel.symbols.GetConsoleMode(handle, mode)) {
        // QuickEdit consumes wheel events and can freeze rendering. Captured
        // mode needs VT input + mouse events; native mode restores selection.
        const current = mode[0] ?? 0;
        const next = captureMouse
          ? (current | 0x200 | 0x10 | 0x80) & ~0x40
          : current | 0xc0;
        if (next !== current) kernel.symbols.SetConsoleMode(handle, next);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (canRestore)
        kernel.symbols.SetConsoleMode(originalHandle, originalMode[0] ?? 0);
      kernel.close();
    },
  };
}
