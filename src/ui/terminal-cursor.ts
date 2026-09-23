/**
 * Ink hides the VT cursor, but classic Windows console hosts can still leave
 * their native cursor blinking below our fixed-height frame. Keep both cursor
 * mechanisms in sync and restore the shell's original native cursor on exit.
 */
export async function createTerminalCursorGuard(
  enabled: boolean,
): Promise<{ hide(): void; restore(): void }> {
  const noop = { hide() {}, restore() {} };
  if (!enabled || process.platform !== "win32" || !process.stdout.isTTY)
    return noop;

  let native: Awaited<ReturnType<typeof loadNativeConsoleCursor>> | undefined;
  try {
    native = await loadNativeConsoleCursor();
  } catch {
    // VT cursor controls below still work in modern terminals.
  }

  let hidden = false;
  let restored = false;
  return {
    hide() {
      if (restored) return;
      try {
        process.stdout.write("\x1b[?25l");
      } catch {
        // The output stream may have closed during startup.
      }
      try {
        native?.hide();
      } catch {
        // Keep the VT path available if the native console handle changed.
      }
      hidden = true;
    },
    restore() {
      if (restored) return;
      restored = true;
      try {
        if (hidden) process.stdout.write("\x1b[?25h");
      } catch {
        // Best effort on a closing terminal.
      }
      try {
        native?.restore();
      } catch {
        // The console may already have been detached.
      }
    },
  };
}

async function loadNativeConsoleCursor(): Promise<{
  hide(): void;
  restore(): void;
}> {
  const { dlopen } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleCursorInfo: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleCursorInfo: { args: ["ptr", "ptr"], returns: "i32" },
  });
  const original = new Uint32Array(2);
  const handle = kernel.symbols.GetStdHandle(-11);
  if (!handle || !kernel.symbols.GetConsoleCursorInfo(handle, original)) {
    kernel.close();
    throw new Error("No native console cursor");
  }
  let closed = false;
  return {
    hide() {
      const active = kernel.symbols.GetStdHandle(-11);
      if (!active) return;
      const info = new Uint32Array(2);
      if (!kernel.symbols.GetConsoleCursorInfo(active, info)) return;
      info[1] = 0;
      kernel.symbols.SetConsoleCursorInfo(active, info);
    },
    restore() {
      if (closed) return;
      closed = true;
      const active = kernel.symbols.GetStdHandle(-11);
      if (active) kernel.symbols.SetConsoleCursorInfo(active, original);
      kernel.close();
    },
  };
}
