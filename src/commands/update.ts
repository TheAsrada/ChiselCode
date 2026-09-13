/**
 * Проверка обновлений ChiselCode через GitHub Releases.
 * Чистая логика + тонкий сетевой слой с таймаутом, чтобы `chisel update`
 * никогда не висел в плохом сетевом окружении.
 */

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

/** Сравнение semver без зависимостей: 1 → a новее, -1 → b новее, 0 → равны. */
export function compareVersions(a: string, b: string): number {
  const pa = normalize(a);
  const pb = normalize(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function normalize(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });
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
  if (process.platform === "win32") return `ChiselCode-Setup-${version}.exe`;
  if (process.platform === "darwin")
    return (
      `ChiselCode-Setup-${version}-macos-${process.arch === "arm64" ? "arm64" : "x64"}.pkg ` +
      `(или соберите из исходников)`
    );
  return `ChiselCode-Setup-${version}-linux-amd64.deb`;
}
