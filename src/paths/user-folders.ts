import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { RuntimeError } from "../runtime/errors.js";

const execute = promisify(execFile);
export type UserFolder = "desktop" | "downloads";
/** Parses XDG data, never shell code. All other variables/substitutions are rejected. */
export function xdgUserFolder(
  text: string,
  folder: UserFolder,
  home: string,
): string | undefined {
  const key = folder === "desktop" ? "DESKTOP" : "DOWNLOAD";
  const match = new RegExp(
    `^XDG_${key}_DIR="((?:[^"\\\\]|\\\\.)*)"\\s*$`,
    "m",
  ).exec(text);
  if (!match) return;
  const value = match[1]!
    .replace(/\\([\\"$`])/g, "$1")
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
  if (
    /[\r\n$`]/.test(value) ||
    value.includes(String.fromCharCode(0)) ||
    !posix.isAbsolute(value)
  )
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Некорректная настройка каталога XDG.",
    );
  if (posix.resolve(value) === posix.resolve(home))
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Этот каталог отключён в настройках XDG; укажите путь внутри проекта.",
    );
  return posix.resolve(value);
}
export async function userFolder(
  folder: UserFolder,
  signal?: AbortSignal,
): Promise<string> {
  let path: string;
  if (process.platform === "win32") {
    // Fixed OS query only: no model-supplied command, URL or path is evaluated.
    const id =
      folder === "desktop"
        ? "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"
        : "374DE290-123F-4565-9164-39C4925E467B";
    // Known Folder API handles redirection and also defaults not materialized in the registry.
    // DONT_VERIFY resolves the folder without creating it before write approval.
    const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new();Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ChiselKnownFolder { [DllImport("shell32.dll")] private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path); public static string Get(string value) { Guid id = new Guid(value); IntPtr path; int status = SHGetKnownFolderPath(ref id, 0x4000, IntPtr.Zero, out path); if (status != 0) Marshal.ThrowExceptionForHR(status); try { return Marshal.PtrToStringUni(path); } finally { Marshal.FreeCoTaskMem(path); } } }';[ChiselKnownFolder]::Get('${id}')`;
    path = (
      await execute(
        win32.join(
          process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { signal, timeout: 5000, windowsHide: true, maxBuffer: 16384 },
      )
    ).stdout.trim();
  } else if (process.platform === "darwin") {
    path = (
      await execute(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('Foundation'); ObjC.unwrap($.NSFileManager.defaultManager.URLsForDirectoryInDomains(${folder === "desktop" ? 12 : 15}, 1).firstObject.path)`,
        ],
        { signal, timeout: 5000, maxBuffer: 16384 },
      )
    ).stdout.trim();
  } else {
    const home = homedir();
    let text = "";
    try {
      text = await readFile(
        join(
          process.env.XDG_CONFIG_HOME || join(home, ".config"),
          "user-dirs.dirs",
        ),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    path =
      xdgUserFolder(text, folder, home) ??
      join(home, folder === "desktop" ? "Desktop" : "Downloads");
  }
  if (
    !path ||
    !isAbsolute(path) ||
    /[\r\n]/.test(path) ||
    path.includes(String.fromCharCode(0))
  )
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "ОС не вернула каталог пользователя; укажите путь внутри проекта.",
    );
  return resolve(path);
}
