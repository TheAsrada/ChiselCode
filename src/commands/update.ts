/**
 * Проверка обновлений ChiselCode через GitHub Releases + самообновление:
 * `/update` в TUI скачивает установщик нового релиза и запускает его тихо
 * (/S, без окон — установщик сам перезапускает приложение).
 * Чистая логика + тонкий сетевой слой с таймаутом, чтобы `chisel update`
 * никогда не висел в плохом сетевом окружении.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RELEASES_LATEST_URL =
  "https://api.github.com/repos/TheAsrada/ChiselCode/releases/latest";
export const RELEASES_PAGE_URL =
  "https://github.com/TheAsrada/ChiselCode/releases";

export interface UpdateCheckResult {
  current: string;
  latest?: string;
  latestUrl?: string;
  updateAvailable?: boolean;
  /** Текст ошибки сети/API — показывается как предупреждение, а не фатально. */
  error?: string;
}

export interface UpdateCheckOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Сравнение версий: 1 → a новее, -1 → b новее, 0 → равны.
 * Числовые части — по числу, суффикс через дефис — пререлиз:
 * релиз новее своего пререлиза (0.5.8 > 0.5.8-beta), суффикс сборки
 * через плюс на старшинство не влияет (1.2.3+build = 1.2.3).
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitCore(a);
  const [coreB, preB] = splitCore(b);
  const length = Math.max(coreA.length, coreB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

/** Чистит версию: пробелы, ведущий v, суффикс сборки +build. */
export function normalizeVersion(version: string): string {
  const cleaned = version.trim().replace(/^v/i, "");
  const plus = cleaned.indexOf("+");
  return plus === -1 ? cleaned : cleaned.slice(0, plus);
}

function splitCore(version: string): [number[], string] {
  const cleaned = normalizeVersion(version);
  const dash = cleaned.indexOf("-");
  const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const pre = dash === -1 ? "" : cleaned.slice(dash + 1);
  return [
    core.split(".").map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    }),
    pre,
  ];
}

export async function checkForUpdates(
  current: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RELEASES_LATEST_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `chiselcode/${current}`,
      },
    });
    if (response.status === 404)
      return { current, error: "Релизы пока не опубликованы." };
    if (response.status === 403)
      return {
        current,
        error:
          "GitHub API вернул 403: исчерпан лимит запросов (60/ч без токена, общий на сеть). Попробуйте позже.",
      };
    if (!response.ok)
      return { current, error: `GitHub API вернул ${response.status}.` };
    const data = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
    };
    const latest = (data.tag_name ?? "").trim().replace(/^v/i, "");
    if (!latest)
      return { current, error: "Не удалось прочитать версию релиза." };
    return {
      current,
      latest,
      latestUrl: data.html_url ?? RELEASES_PAGE_URL,
      updateAvailable: compareVersions(latest, current) > 0,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      current,
      error: aborted
        ? "Превышено время ожидания GitHub API."
        : `Нет соединения с GitHub: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Имя установщика под текущую платформу — как в release.yml. */
export function installerAssetHint(version: string): string {
  const asset = installerAssetName(version);
  if (process.platform === "darwin")
    return `${asset} (или соберите из исходников)`;
  return asset;
}

/** Точное имя файла установщика в релизе под платформу/архитектуру. */
export function installerAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform === "win32") return `ChiselCode-Setup-${version}.exe`;
  if (platform === "darwin")
    return `ChiselCode-Setup-${version}-macos-${arch === "arm64" ? "arm64" : "x64"}.pkg`;
  return `ChiselCode-Setup-${version}-linux-amd64.deb`;
}

/** Прямая ссылка на файл установщика в GitHub-релизе. */
export function releaseDownloadUrl(version: string, asset: string): string {
  const clean = normalizeVersion(version);
  return `${RELEASES_PAGE_URL}/download/v${clean}/${asset}`;
}

/**
 * Есть ли файл уже в релизе (HEAD-запрос). Релиз создаётся пустым,
 * установщики доливаются минутами позже — качать 404 бессмысленно.
 * false — только при честном 404; любая другая неудача проверки
 * возвращает true, и разбираться будет уже скачивание.
 */
export async function checkAssetAvailable(
  url: string,
  options: UpdateCheckOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    return response.status !== 404;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запущен ли CLI как установленный бинарник (`chisel`/`chisel.exe`),
 * а не из исходников через `bun`. Самообновление имеет смысл только
 * для установленного бинарника.
 */
export function isInstalledBinary(execPath = process.execPath): boolean {
  // basename() из node:path на POSIX не режет обратные слэши, поэтому
  // разбираем обе нотации вручную — иначе Windows-пути не распознаются
  // на macOS/Linux (и в CI-тестах).
  const name =
    execPath
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? "";
  return name === "chisel" || name.startsWith("chisel-");
}

export interface SelfUpdatePlan {
  current: string;
  latest?: string;
  latestUrl?: string;
  updateAvailable: boolean;
  /** Ошибка проверки — дальше флоу не идёт. */
  error?: string;
  /** Файл установщика и ссылка (заполнены, если обновление есть). */
  asset: string;
  url: string;
  /** Запуск из установленного бинарника (не из исходников). */
  installedBinary: boolean;
  /** Тихая установка без sudo: установленный бинарник на Windows. */
  autoInstall: boolean;
  /** Команда ручной установки для macOS/Linux. */
  manualCommand?: string;
}

/** Строит план самообновления из результата проверки версии. */
export function planSelfUpdate(
  check: UpdateCheckResult,
  current: string,
  platform: NodeJS.Platform = process.platform,
): SelfUpdatePlan {
  const latest = normalizeVersion(check.latest ?? current);
  const asset = installerAssetName(latest, platform);
  const installedBinary = isInstalledBinary();
  const autoInstall = installedBinary && platform === "win32";
  return {
    current,
    latest: check.latest === undefined ? undefined : latest,
    latestUrl: check.latestUrl,
    updateAvailable: check.updateAvailable ?? false,
    error: check.error,
    asset,
    url: releaseDownloadUrl(latest, asset),
    installedBinary,
    autoInstall,
    manualCommand: autoInstall
      ? undefined
      : manualInstallCommand(join(tmpdir(), asset), platform),
  };
}

/** Команда ручной установки скачанного файла для macOS/Linux. */
export function manualInstallCommand(
  assetPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "darwin")
    return `sudo installer -pkg "${assetPath}" -target /`;
  if (platform === "linux") return `sudo apt install "${assetPath}"`;
  return undefined;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  destDir?: string;
}

export interface DownloadedAsset {
  path: string;
  bytes: number;
}

/**
 * Скачивает файл релиза во временную папку. Льёт потоком сразу на диск,
 * а не копит весь установщик в памяти. Бросает понятную ошибку.
 */
export async function downloadReleaseAsset(
  url: string,
  asset: string,
  options: DownloadOptions = {},
): Promise<DownloadedAsset> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const path = join(options.destDir ?? tmpdir(), asset);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok)
      throw new Error(
        `Сервер вернул ${response.status} при скачивании ${asset}.`,
      );
    const body = response.body as unknown as AsyncIterable<
      Uint8Array | string
    > | null;
    if (!body || typeof body[Symbol.asyncIterator] !== "function") {
      // Мокнутый/нестандартный ответ без потокового тела — по-старому.
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(path, bytes);
      return { path, bytes: bytes.byteLength };
    }
    let bytes = 0;
    const file = createWriteStream(path);
    try {
      for await (const chunk of body) {
        bytes +=
          typeof chunk === "string"
            ? Buffer.byteLength(chunk)
            : chunk.byteLength;
        // once() отваливается и по 'error': битый диск не повесит скачивание.
        if (!file.write(chunk)) await once(file, "drain");
      }
    } catch (error) {
      file.destroy();
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      file.on("error", reject);
      file.end(() => resolve());
    });
    return { path, bytes };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("Превышено время ожидания скачивания установщика.");
    // Не тащим за собой оборванный файл: следующая попытка качнёт заново.
    await unlink(path).catch(() => {});
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запускает Windows-установщик отдельно от текущего процесса и сразу
 * возвращается: вызывающий код после этого закрывает приложение, чтобы
 * установщик мог заменить файлы.
 *
 * Тихий режим NSIS (/S): ни одного окна — установщик ставит всё молча.
 * Используется командой /update: пользователь уже подтвердил обновление,
 * кликать по пяти страницам мастера незачем. После тихой установки
 * установщик сам перезапускает приложение (см. chiselcode.nsi).
 */
export const NSIS_SILENT_ARGS: readonly string[] = ["/S"];

export function launchWindowsInstaller(
  assetPath: string,
  args: readonly string[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(assetPath, [...args], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
    } catch (error) {
      reject(toLaunchError(assetPath, error));
      return;
    }
    child.once("error", (error) => reject(toLaunchError(assetPath, error)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function toLaunchError(assetPath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Не удалось запустить установщик ${assetPath}: ${detail}. Проверьте, что файл на месте и не заблокирован антивирусом.`,
  );
}
