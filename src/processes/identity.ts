import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
export interface ProcessIdentity {
  host: string;
  pid: number;
  start?: string;
}
let currentIdentity: Promise<ProcessIdentity> | undefined;
/** The native birth identity of this process cannot change; avoid repeated CIM/ps helpers. */
export function currentProcessIdentity(): Promise<ProcessIdentity> {
  currentIdentity ??= processIdentity(process.pid).then((value) =>
    Object.freeze(value),
  );
  return currentIdentity;
}
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const identity = { host: hostname(), pid };
  try {
    if (process.platform === "linux") {
      const value = await readFile(`/proc/${pid}/stat`, "utf8"),
        boot = (
          await readFile("/proc/sys/kernel/random/boot_id", "utf8")
        ).trim();
      return {
        ...identity,
        start: `linux:${boot}:${value.slice(value.lastIndexOf(")") + 2).split(" ")[19]}`,
      };
    }
    const result =
      process.platform === "win32"
        ? await execa(
            join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p){$p.CreationDate.ToUniversalTime().Ticks}`,
            ],
            {
              timeout: 3000,
              stdin: "ignore",
              maxBuffer: 4096,
              windowsHide: true,
            },
          )
        : await execa("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
            timeout: 3000,
            stdin: "ignore",
            maxBuffer: 4096,
          });
    const start = result.stdout.trim();
    return {
      ...identity,
      ...(start ? { start: `${process.platform}:${start}` } : {}),
    };
  } catch {
    return identity;
  }
}
export async function identityState(
  identity: ProcessIdentity,
): Promise<"live" | "dead" | "unknown"> {
  if (identity.host !== hostname() || !identity.start) return "unknown";
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "unknown";
  }
  const current = await (identity.pid === process.pid
    ? currentProcessIdentity()
    : processIdentity(identity.pid));
  if (!current.start) return "unknown";
  return current.start === identity.start ? "live" : "dead";
}
