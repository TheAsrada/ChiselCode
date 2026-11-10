import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type UpdateChannel =
  | "windows"
  | "macos"
  | "deb"
  | "rpm"
  | "arch"
  | "curl"
  | "portable"
  | "brew"
  | "aur"
  | "npm"
  | "bun"
  | "source";

export const updateChannelLabels: Record<UpdateChannel, string> = {
  windows: "Windows Setup",
  macos: "macOS Installer",
  deb: "DEB",
  rpm: "RPM",
  arch: "pacman",
  curl: "install.sh",
  portable: "Переносимый архив",
  brew: "Homebrew",
  aur: "AUR",
  npm: "npm",
  bun: "Bun",
  source: "Исходники",
};

export function detectUpdateChannel(
  platform: NodeJS.Platform,
  execPath: string,
  installedBinary: boolean,
  entry = process.argv[1],
): UpdateChannel {
  if (!installedBinary) {
    const path = entry && existingPath(entry)?.replaceAll("\\", "/");
    if (!path?.endsWith("/node_modules/chiselcode/dist/cli.js"))
      return "source";
    const bunRoot = resolve(process.env.BUN_INSTALL || join(homedir(), ".bun"));
    const globalDir = existingPath(
      join(bunRoot, "install", "global"),
    )?.replaceAll("\\", "/");
    return globalDir && path.startsWith(`${globalDir}/`) ? "bun" : "npm";
  }
  if (platform === "win32") return "windows";
  const binary = existingPath(execPath) ?? execPath;
  if (/\/Cellar\/chiselcode\/[^/]+\/libexec\/chisel$/.test(binary))
    return "brew";
  if (platform === "darwin") return "macos";
  if (platform !== "linux") return "portable";
  try {
    if (
      readFileSync(join(dirname(binary), ".chisel-install-channel"), "utf8") ===
      "curl\n"
    )
      return "curl";
  } catch {
    // The marker is present only in releases installed by install.sh.
  }
  if (binary === "/usr/bin/chisel") {
    if (
      owner("/usr/bin/dpkg-query", ["-S", binary]) === `chiselcode: ${binary}`
    )
      return "deb";
    if (
      owner("/usr/bin/rpm", ["-qf", "--qf", "%{NAME}", binary]) === "chiselcode"
    )
      return "rpm";
    const archPackage = owner("/usr/bin/pacman", ["-Qqo", binary]);
    if (archPackage === "chiselcode") return "arch";
    if (archPackage === "chiselcode-bin") return "aur";
  }
  return "portable";
}

function existingPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function owner(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
