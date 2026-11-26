import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Playwright from "playwright-core";
import { extractBackendArchive } from "../lsp/archive.js";
import { chiselHomeDir } from "../paths/home.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";

export const playwrightVersion = "1.65.1";
export const chromiumVersion = "159.0.8154.6";
const archiveDir = "chrome-headless-shell-linux64";
const versionKey = `playwright-${playwrightVersion}-chromium-${chromiumVersion}`;
const playwrightIntegrity =
  "hqPpz7blSMPxWVdoeE1yiBSzXsKiVOd2k+kjCvmUywD2GPO2Dd9HfcWnq9NN0GHbNZDFgZ9JfBFr+X5/BLo0qw==";
const chromiumIntegrity =
  "77a6442fd3c8acd3bef9e1067fc26f5ef464277d22f0e8cb58dc3e4077a3e458";
const browserCache = () => join(chiselHomeDir(), "cache", "browser");
const installedDir = () => join(browserCache(), versionKey);

export function platformSupported() {
  return process.platform === "linux" && process.arch === "x64";
}

function requirePlatform() {
  if (!platformSupported())
    throw new RuntimeError(
      "BROWSER_UNAVAILABLE",
      "Browser runtime is available on Linux x64.",
    );
}

export async function browserInstallState(): Promise<
  "ready" | "missing" | "unavailable"
> {
  if (!platformSupported()) return "unavailable";
  try {
    await Promise.all([
      access(join(installedDir(), "package", "index.mjs")),
      access(
        join(installedDir(), archiveDir, "chrome-headless-shell"),
        constants.X_OK,
      ),
    ]);
    return "ready";
  } catch {
    return "missing";
  }
}

export async function loadChromium() {
  requirePlatform();
  if ((await browserInstallState()) !== "ready")
    throw new RuntimeError(
      "BROWSER_RUNTIME_MISSING",
      "Open /browser and choose «Установить Chromium», or run /browser install in Build.",
    );
  try {
    const moduleUrl = pathToFileURL(
      join(installedDir(), "package", "index.mjs"),
    );
    const playwright = (await import(moduleUrl.href)) as typeof Playwright;
    return {
      chromium: playwright.chromium,
      executableDir: join(installedDir(), archiveDir),
    };
  } catch {
    throw new RuntimeError(
      "BROWSER_RUNTIME_MISSING",
      "Playwright cache is unreadable. Remove the pinned cache directory and run /browser install.",
    );
  }
}

async function download(url: string, maxBytes: number, signal?: AbortSignal) {
  const response = await fetch(url, { redirect: "error", signal });
  if (!response.ok || !response.body)
    throw new Error("Не удалось скачать архив.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    cancelled(signal);
    size += chunk.length;
    if (size > maxBytes) throw new Error("Архив превышает лимит размера.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** Both archives are fixed and verified before extraction. Only the browser cache is published. */
export async function installBrowser(signal?: AbortSignal) {
  requirePlatform();
  const cache = browserCache();
  await mkdir(cache, { recursive: true, mode: 0o700 });
  return withLock(
    installedDir(),
    async (assertOwned) => {
      if ((await browserInstallState()) === "ready") return;
      const staging = await mkdtemp(join(cache, "install-"));
      try {
        const archive = await download(
          `https://registry.npmjs.org/playwright-core/-/playwright-core-${playwrightVersion}.tgz`,
          8 * 1024 * 1024,
          signal,
        );
        if (
          createHash("sha512").update(archive).digest("base64") !==
          playwrightIntegrity
        )
          throw new Error("Контрольная сумма Playwright не совпала.");
        await extractBackendArchive(archive, "tar.gz", staging, signal);

        const chromium = await download(
          `https://storage.googleapis.com/chrome-for-testing-public/${chromiumVersion}/linux64/${archiveDir}.zip`,
          150 * 1024 * 1024,
          signal,
        );
        if (
          createHash("sha256").update(chromium).digest("hex") !==
          chromiumIntegrity
        )
          throw new Error("Контрольная сумма Chromium не совпала.");
        // The verified Chrome for Testing archive supplies its own file modes.
        await Bun.write(join(staging, "chromium.zip"), chromium);
        cancelled(signal);
        const unpack = Bun.spawn(
          [
            "/usr/bin/unzip",
            "-qo",
            join(staging, "chromium.zip"),
            "-d",
            staging,
          ],
          {
            env: { PATH: "/usr/bin:/bin", LANG: "C" },
            stdout: "ignore",
            stderr: "ignore",
            signal,
          },
        );
        if ((await unpack.exited) !== 0)
          throw new Error(
            "Не удалось распаковать Chromium. Проверьте /usr/bin/unzip.",
          );
        await rm(join(staging, "chromium.zip"));
        await access(
          join(staging, archiveDir, "chrome-headless-shell"),
          constants.X_OK,
        );
        cancelled(signal);
        await assertOwned();
        await rm(installedDir(), { recursive: true, force: true });
        await rename(staging, installedDir());
      } catch (error) {
        cancelled(signal);
        throw new RuntimeError(
          "BROWSER_UNAVAILABLE",
          error instanceof Error
            ? error.message
            : "Не удалось установить Chromium.",
        );
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    signal,
  );
}
