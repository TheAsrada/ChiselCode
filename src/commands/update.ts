/**
 * Проверка обновлений ChiselCode через GitHub Releases + самообновление:
 * `/update` в TUI показывает проверку и скачивание в отдельном диалоге.
 * Windows-установщик запускается только после выбора перезапуска.
 * Чистая логика + тонкий сетевой слой с таймаутом, чтобы `chisel update`
 * никогда не висел в плохом сетевом окружении.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RELEASES_LATEST_URL =
  "https://api.github.com/repos/TheAsrada/ChiselCode/releases/latest";
export const RELEASES_PAGE_URL =
  "https://github.com/TheAsrada/ChiselCode/releases";

export interface UpdateCheckResult {
  current: string;
  latest?: string;
  latestUrl?: string;
  updateAvailable?: boolean;
  assets?: ReleaseAsset[];
  /** Текст ошибки сети/API — показывается как предупреждение, а не фатально. */
  error?: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

export interface UpdateCheckOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
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
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
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
      draft?: boolean;
      prerelease?: boolean;
      html_url?: string;
      assets?: Array<{
        name?: string;
        browser_download_url?: string;
        size?: number;
        digest?: string | null;
      }>;
    };
    const latest = (data.tag_name ?? "").trim().replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(latest))
      return { current, error: "Не удалось прочитать версию релиза." };
    if (data.draft || data.prerelease)
      return { current, error: "Стабильный релиз пока не опубликован." };
    return {
      current,
      latest,
      latestUrl: data.html_url ?? RELEASES_PAGE_URL,
      updateAvailable: compareVersions(latest, current) > 0,
      assets: data.assets?.flatMap((asset) => {
        if (
          !asset.name ||
          !asset.browser_download_url ||
          !Number.isSafeInteger(asset.size) ||
          (asset.size ?? 0) <= 0
        )
          return [];
        const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
        return [
          {
            name: asset.name,
            url: asset.browser_download_url,
            size: asset.size as number,
            sha256: digest?.[1]?.toLowerCase(),
          },
        ];
      }),
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
  platform?: NodeJS.Platform;
  latest?: string;
  latestUrl?: string;
  updateAvailable: boolean;
  /** Ошибка проверки — дальше флоу не идёт. */
  error?: string;
  /** Файл установщика и ссылка (заполнены, если обновление есть). */
  asset: string;
  url: string;
  assetReady?: boolean;
  assetSize?: number;
  sha256?: string;
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
  arch: NodeJS.Architecture = process.arch,
  execPath = process.execPath,
): SelfUpdatePlan {
  const latest = normalizeVersion(check.latest ?? current);
  const asset = installerAssetName(latest, platform, arch);
  const publishedAsset = check.assets?.find((item) => item.name === asset);
  const digestError =
    check.updateAvailable && publishedAsset && !publishedAsset.sha256
      ? "GitHub не сообщил SHA-256 установщика. Автоматическое обновление остановлено."
      : undefined;
  const supported =
    ((platform === "win32" || platform === "linux") && arch === "x64") ||
    (platform === "darwin" && (arch === "x64" || arch === "arm64"));
  const platformError =
    check.updateAvailable && !supported
      ? `Для ${platform}/${arch} готовый установщик не опубликован.`
      : undefined;
  const installedBinary = isInstalledBinary(execPath);
  const autoInstall = installedBinary && platform === "win32";
  return {
    current,
    platform,
    latest: check.latest === undefined ? undefined : latest,
    latestUrl: check.latestUrl,
    updateAvailable: check.updateAvailable ?? false,
    error: check.error ?? platformError ?? digestError,
    asset,
    url: publishedAsset?.url ?? releaseDownloadUrl(latest, asset),
    assetReady: check.assets ? Boolean(publishedAsset) : undefined,
    assetSize: publishedAsset?.size,
    sha256: publishedAsset?.sha256,
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

export interface DownloadProgress {
  phase: "downloading" | "verifying";
  bytes: number;
  totalBytes?: number;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  destDir?: string;
  expectedBytes?: number;
  expectedSha256?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
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
  if (!/^[\w.+-]+$/.test(asset) || asset === "." || asset === "..")
    throw new Error("Недопустимое имя файла установщика.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  signal.throwIfAborted();
  const temporaryDir =
    options.destDir ?? (await mkdtemp(join(tmpdir(), "chisel-update-")));
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 300_000,
  );
  const path = join(temporaryDir, asset);
  let started = false;
  try {
    const response = await fetchImpl(url, { signal });
    signal.throwIfAborted();
    if (!response.ok)
      throw new Error(
        `Сервер вернул ${response.status} при скачивании ${asset}.`,
      );
    const length = Number(response.headers?.get("content-length"));
    const totalBytes =
      options.expectedBytes ??
      (Number.isSafeInteger(length) && length > 0 ? length : undefined);
    let bytes = 0;
    const hash = createHash("sha256");
    const progress = (phase: DownloadProgress["phase"]) =>
      options.onProgress?.({ phase, bytes, totalBytes });
    const accept = (chunk: Uint8Array | string) => {
      signal.throwIfAborted();
      bytes +=
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (options.expectedBytes !== undefined && bytes > options.expectedBytes)
        throw new Error(
          "Размер скачанного установщика не совпадает с релизом.",
        );
      hash.update(chunk);
      progress("downloading");
    };
    progress("downloading");
    const body = response.body as unknown as AsyncIterable<
      Uint8Array | string
    > | null;
    if (!body || typeof body[Symbol.asyncIterator] !== "function") {
      const payload = new Uint8Array(await response.arrayBuffer());
      accept(payload);
      started = true;
      await writeFile(path, payload, { signal });
    } else {
      started = true;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            accept(chunk);
            callback(null, chunk);
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      const input =
        typeof response.body?.getReader === "function"
          ? Readable.fromWeb(
              response.body as unknown as Parameters<
                typeof Readable.fromWeb
              >[0],
            )
          : Readable.from(body);
      await pipeline(input, counter, createWriteStream(path), { signal });
    }
    signal.throwIfAborted();
    progress("verifying");
    verifyDownload(bytes, hash.digest("hex"), options);
    return { path, bytes };
  } catch (error) {
    if (started) await unlink(path).catch(() => {});
    if (!options.destDir)
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    if (options.signal?.aborted)
      throw new DOMException("Обновление отменено.", "AbortError");
    if (controller.signal.aborted)
      throw new Error("Превышено время ожидания скачивания установщика.");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function verifyDownload(
  bytes: number,
  sha256: string,
  options: DownloadOptions,
): void {
  if (options.expectedBytes !== undefined && bytes !== options.expectedBytes)
    throw new Error("Размер скачанного установщика не совпадает с релизом.");
  if (options.expectedSha256 && sha256 !== options.expectedSha256)
    throw new Error("Контрольная сумма установщика не совпадает с релизом.");
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

/** Keep the selected project and saved conversation after a silent update. */
export function windowsUpdateArguments(
  projectPath: string,
  sessionId?: string,
): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows restart arguments cannot contain control characters.
  if (/["\r\n\0]/.test(projectPath))
    throw new Error("Недопустимый путь проекта для перезапуска.");
  if (sessionId && !/^[\w-]+$/.test(sessionId))
    throw new Error("Недопустимый ID сессии для перезапуска.");
  return [
    ...NSIS_SILENT_ARGS,
    `/CHISEL_CWD=${projectPath}`,
    ...(sessionId ? [`/CHISEL_RESUME=${sessionId}`] : []),
  ];
}

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
