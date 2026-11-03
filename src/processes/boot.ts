import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { execa } from "execa";
import { z } from "zod";

export const BootStampSchema = z
  .object({
    host: z.string(),
    hostId: z.string().min(1).optional(),
    platform: z.string(),
    bootId: z.string().min(1).optional(),
    uptimeMs: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type BootStamp = z.infer<typeof BootStampSchema>;
let identity: Promise<BootStamp> | undefined;
let ticks: (() => number | bigint) | undefined;

async function bootIdentity(): Promise<BootStamp> {
  const stamp: BootStamp = { host: hostname(), platform: process.platform };
  try {
    if (process.platform === "linux") {
      stamp.hostId = (await readFile("/etc/machine-id", "utf8")).trim();
      stamp.bootId = (
        await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ).trim();
    } else if (process.platform === "darwin") {
      const [machine, boot] = await Promise.all([
        execa("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
          timeout: 3000,
          maxBuffer: 65536,
        }),
        execa("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
          timeout: 3000,
          maxBuffer: 4096,
        }),
      ]);
      stamp.hostId = machine.stdout.match(
        /"IOPlatformUUID"\s*=\s*"([^"]+)"/,
      )?.[1];
      stamp.bootId = boot.stdout.trim();
    } else if (process.platform === "win32") {
      const machine = await execa(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-ItemPropertyValue -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid",
        ],
        { timeout: 3000, maxBuffer: 4096, windowsHide: true },
      );
      stamp.hostId = machine.stdout.trim();
      const { dlopen, FFIType } = await import("bun:ffi");
      const library = dlopen("kernel32.dll", {
        GetTickCount64: { args: [], returns: FFIType.u64 },
      });
      // The handle belongs to this process. Keep the function valid for later probes.
      ticks = () => library.symbols.GetTickCount64();
    }
  } catch {
    // An unavailable native identity cannot prove that a machine restarted.
  }
  if (!stamp.hostId?.trim()) delete stamp.hostId;
  if (!stamp.bootId?.trim()) delete stamp.bootId;
  return stamp;
}
export async function readBootStamp(): Promise<BootStamp> {
  identity ??= bootIdentity();
  const value = { ...(await identity) };
  if (ticks) {
    try {
      const uptime = Number(ticks());
      if (Number.isFinite(uptime) && uptime >= 0) value.uptimeMs = uptime;
    } catch {
      /* Remain unknown. */
    }
  }
  return value;
}
/** Positive evidence only; wall-clock dates and missing PIDs are not evidence. */
export function bootChanged(before: BootStamp, after: BootStamp): boolean {
  if (
    !before.hostId ||
    before.hostId !== after.hostId ||
    before.host !== after.host ||
    before.platform !== after.platform
  )
    return false;
  if (before.platform === "win32")
    return (
      before.uptimeMs !== undefined &&
      after.uptimeMs !== undefined &&
      after.uptimeMs + 1000 < before.uptimeMs
    );
  return !!before.bootId && !!after.bootId && before.bootId !== after.bootId;
}
