import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAssetAvailable,
  checkForUpdates,
  compareVersions,
  type DownloadProgress,
  downloadReleaseAsset,
  installerAssetName,
  isInstalledBinary,
  launchWindowsInstaller,
  manualInstallCommand,
  NSIS_SILENT_ARGS,
  normalizeVersion,
  planSelfUpdate,
  releaseDownloadUrl,
  windowsUpdateArguments,
} from "../../src/commands/update.js";

describe("self update helpers", () => {
  test("uses the published release asset and its checksum", async () => {
    const payload = new TextEncoder().encode("installer");
    const digest = createHash("sha256").update(payload).digest("hex");
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.5.36",
          html_url:
            "https://github.com/TheAsrada/ChiselCode/releases/tag/v0.5.36",
          assets: [
            {
              name: "ChiselCode-Setup-0.5.36.exe",
              browser_download_url: "https://example.test/real-installer.exe",
              size: payload.byteLength,
              digest: `sha256:${digest}`,
            },
          ],
        }),
      )) as unknown as typeof fetch;
    const check = await checkForUpdates("0.5.35", { fetchImpl });
    const plan = planSelfUpdate(check, "0.5.35", "win32", "x64");
    expect(plan.assetReady).toBe(true);
    expect(plan.url).toBe("https://example.test/real-installer.exe");
    expect(plan.assetSize).toBe(payload.byteLength);
    expect(plan.sha256).toBe(digest);
  });

  test("reports a release whose installer is still being uploaded", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.5.36",
          assets: [],
        }),
      )) as unknown as typeof fetch;
    const plan = planSelfUpdate(
      await checkForUpdates("0.5.35", { fetchImpl }),
      "0.5.35",
      "win32",
      "x64",
    );
    expect(plan.updateAvailable).toBe(true);
    expect(plan.assetReady).toBe(false);
  });

  test("does not auto-install a release asset without a checksum", () => {
    const plan = planSelfUpdate(
      {
        current: "0.5.35",
        latest: "0.5.36",
        updateAvailable: true,
        assets: [
          {
            name: "ChiselCode-Setup-0.5.36.exe",
            url: "https://example.test/installer.exe",
            size: 100,
          },
        ],
      },
      "0.5.35",
      "win32",
      "x64",
    );
    expect(plan.error).toContain("SHA-256");
  });
  test("names installer assets per platform like release.yml", () => {
    expect(installerAssetName("0.2.21", "win32", "x64")).toBe(
      "ChiselCode-Setup-0.2.21.exe",
    );
    expect(installerAssetName("0.2.21", "darwin", "arm64")).toBe(
      "ChiselCode-Setup-0.2.21-macos-arm64.pkg",
    );
    expect(installerAssetName("0.2.21", "darwin", "x64")).toBe(
      "ChiselCode-Setup-0.2.21-macos-x64.pkg",
    );
    expect(installerAssetName("0.2.21", "linux", "x64")).toBe(
      "ChiselCode-Setup-0.2.21-linux-amd64.deb",
    );
  });

  test("builds a direct download URL for a release asset", () => {
    expect(releaseDownloadUrl("0.2.21", "ChiselCode-Setup-0.2.21.exe")).toBe(
      "https://github.com/TheAsrada/ChiselCode/releases/download/v0.2.21/ChiselCode-Setup-0.2.21.exe",
    );
    // Версия с v-префиксом и пробелами не даёт vv…/404.
    expect(releaseDownloadUrl(" v0.2.22 ", "ChiselCode-Setup-0.2.22.exe")).toBe(
      "https://github.com/TheAsrada/ChiselCode/releases/download/v0.2.22/ChiselCode-Setup-0.2.22.exe",
    );
    expect(normalizeVersion(" v1.2.3+build ")).toBe("1.2.3");
  });

  test("compares versions with prerelease suffixes", () => {
    expect(compareVersions("0.5.8", "0.5.7")).toBe(1);
    expect(compareVersions("0.5.7", "0.5.8")).toBe(-1);
    expect(compareVersions("0.5.7", "0.5.7")).toBe(0);
    expect(compareVersions("v0.5.8", "0.5.8")).toBe(0);
    // Релиз новее своего пререлиза; stable после beta предлагается.
    expect(compareVersions("0.5.8", "0.5.8-beta")).toBe(1);
    expect(compareVersions("0.5.8-beta", "0.5.8")).toBe(-1);
    expect(compareVersions("0.5.7-hotfix", "0.5.7")).toBe(-1);
    // Суффикс сборки на старшинство не влияет.
    expect(compareVersions("1.2.3+build", "1.2.3")).toBe(0);
  });

  test("detects an installed binary vs running from sources", () => {
    expect(isInstalledBinary("C:\\Users\\user\\AppData\\chisel.exe")).toBe(
      true,
    );
    expect(isInstalledBinary("/usr/local/bin/chisel")).toBe(true);
    expect(isInstalledBinary("/opt/bun/bin/bun")).toBe(false);
    expect(isInstalledBinary("C:\\Program Files\\nodejs\\bun.exe")).toBe(false);
  });

  test("plans no update when already on the latest version", () => {
    const plan = planSelfUpdate(
      { current: "0.2.21", latest: "0.2.21", updateAvailable: false },
      "0.2.21",
      "win32",
      "x64",
    );
    expect(plan.updateAvailable).toBe(false);
    expect(plan.error).toBeUndefined();
  });

  test("plans an update with asset and URL", () => {
    const plan = planSelfUpdate(
      {
        current: "0.2.21",
        latest: "0.2.22",
        latestUrl: "https://example.test/r",
        updateAvailable: true,
      },
      "0.2.21",
      "win32",
      "x64",
    );
    expect(plan.updateAvailable).toBe(true);
    expect(plan.asset).toBe("ChiselCode-Setup-0.2.22.exe");
    expect(plan.url).toContain("/download/v0.2.22/ChiselCode-Setup-0.2.22.exe");
  });

  test("normalizes a v-prefixed latest version in the plan", () => {
    const plan = planSelfUpdate(
      {
        current: "0.2.21",
        latest: "v0.2.22",
        updateAvailable: true,
      },
      "0.2.21",
      "win32",
      "x64",
    );
    expect(plan.latest).toBe("0.2.22");
    expect(plan.asset).toBe("ChiselCode-Setup-0.2.22.exe");
    expect(plan.url).toContain("/download/v0.2.22/");
    expect(plan.url).not.toContain("vv");
  });

  test("passes check errors through to the plan", () => {
    const plan = planSelfUpdate(
      { current: "0.2.21", error: "Нет соединения" },
      "0.2.21",
      "win32",
      "x64",
    );
    expect(plan.updateAvailable).toBe(false);
    expect(plan.error).toBe("Нет соединения");
  });

  test("locks the silent NSIS contract for one-click updates", () => {
    // /update запускает установщик тихо (/S): контракт флага в одном месте,
    // чтобы GUI-установщик и тихий не разъехались.
    expect([...NSIS_SILENT_ARGS]).toEqual(["/S"]);
  });

  test("suggests a manual install command off Windows", () => {
    expect(manualInstallCommand("/tmp/x.pkg", "darwin")).toContain(
      "installer -pkg",
    );
    expect(manualInstallCommand("/tmp/x.deb", "linux")).toContain(
      "apt install",
    );
    expect(manualInstallCommand("C:\\Temp\\x.exe", "win32")).toBeUndefined();
  });

  test("downloads a release asset with an injected fetch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-update-"));
    try {
      const payload = new TextEncoder().encode("x".repeat(256));
      const fetchImpl = (async () =>
        new Response(payload)) as unknown as typeof fetch;
      const result = await downloadReleaseAsset(
        "https://example.test/ChiselCode-Setup-9.9.9.exe",
        "ChiselCode-Setup-9.9.9.exe",
        { fetchImpl, destDir: directory },
      );
      expect(result.bytes).toBe(256);
      expect(result.path).toBe(join(directory, "ChiselCode-Setup-9.9.9.exe"));
      expect(await Bun.file(result.path).arrayBuffer()).toHaveLength(256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a damaged installer and removes the partial download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-update-"));
    try {
      const fetchImpl = (async () =>
        new Response("damaged")) as unknown as typeof fetch;
      const asset = "ChiselCode-Setup-test.exe";
      await expect(
        downloadReleaseAsset("https://example.test/a.exe", asset, {
          fetchImpl,
          destDir: directory,
          expectedBytes: 7,
          expectedSha256: "0".repeat(64),
        }),
      ).rejects.toThrow("Контрольная сумма");
      await expect(readFile(join(directory, asset))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails download on a non-OK response", async () => {
    const fetchImpl = (async () =>
      new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadReleaseAsset("https://example.test/missing.exe", "missing.exe", {
        fetchImpl,
        destDir: tmpdir(),
      }),
    ).rejects.toThrow("404");
  });

  test("streams large payloads to disk without buffering it all", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-update-"));
    try {
      const payload = new TextEncoder().encode("y".repeat(262144));
      const fetchImpl = (async () =>
        new Response(payload)) as unknown as typeof fetch;
      const result = await downloadReleaseAsset(
        "https://example.test/big.exe",
        "big.exe",
        { fetchImpl, destDir: directory },
      );
      expect(result.bytes).toBe(262144);
      const stored = await Bun.file(result.path).bytes();
      expect(stored).toHaveLength(262144);
      expect(stored[0]).toBe("y".charCodeAt(0));
      expect(stored[262143]).toBe("y".charCodeAt(0));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("falls back to arrayBuffer without a stream body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-update-"));
    try {
      const payload = new TextEncoder().encode("z".repeat(64));
      const fetchImpl = (async () => ({
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => payload.buffer as ArrayBuffer,
      })) as unknown as typeof fetch;
      const result = await downloadReleaseAsset(
        "https://example.test/old.exe",
        "old.exe",
        { fetchImpl, destDir: directory },
      );
      expect(result.bytes).toBe(64);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("checks asset presence with HEAD", async () => {
    const ok = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const missing = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    const broken = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(
      checkAssetAvailable("https://example.test/a.exe", { fetchImpl: ok }),
    ).resolves.toBe(true);
    await expect(
      checkAssetAvailable("https://example.test/a.exe", { fetchImpl: missing }),
    ).resolves.toBe(false);
    // Не смогли проверить — пробуем качать, разберётся скачивание.
    await expect(
      checkAssetAvailable("https://example.test/a.exe", { fetchImpl: broken }),
    ).resolves.toBe(true);
  });

  test("launch fails fast on a missing installer file", async () => {
    await expect(
      launchWindowsInstaller(
        join(tmpdir(), "chiselcode-no-such-file-12345.exe"),
        ["/S"],
      ),
    ).rejects.toThrow("Не удалось запустить установщик");
  });

  test("launch resolves once the child is spawned", async () => {
    // Собственный рантайм как безвредный дочерний процесс.
    await expect(
      launchWindowsInstaller(process.execPath, ["--version"]),
    ).resolves.toBeUndefined();
  });
});

describe("update progress and cancellation", () => {
  test("reports real streamed bytes and verifies only after downloading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chisel-progress-"));
    const payload = new TextEncoder().encode("x".repeat(1024));
    const progress: DownloadProgress[] = [];
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(payload.slice(0, 256));
            controller.enqueue(payload.slice(256, 768));
            controller.enqueue(payload.slice(768));
            controller.close();
          },
        }),
      )) as unknown as typeof fetch;
    try {
      const result = await downloadReleaseAsset(
        "https://example.test/a",
        "a.exe",
        {
          fetchImpl,
          destDir: directory,
          expectedBytes: 1024,
          expectedSha256: createHash("sha256").update(payload).digest("hex"),
          onProgress: (value) => progress.push(value),
        },
      );
      expect(result.bytes).toBe(1024);
      expect(progress.map((value) => value.bytes)).toEqual([
        0, 256, 768, 1024, 1024,
      ]);
      expect(progress.every((value) => value.totalBytes === 1024)).toBe(true);
      expect(progress.at(-1)?.phase).toBe("verifying");
      expect(await readFile(result.path)).toEqual(Buffer.from(payload));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cancels a partially downloaded installer and removes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chisel-cancel-"));
    const abort = new AbortController();
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
          },
        }),
      )) as unknown as typeof fetch;
    try {
      await expect(
        downloadReleaseAsset("https://example.test/a", "a.exe", {
          fetchImpl,
          destDir: directory,
          signal: abort.signal,
          onProgress: (value) => {
            if (value.bytes > 0) abort.abort();
          },
        }),
      ).rejects.toThrow("Обновление отменено");
      await expect(readFile(join(directory, "a.exe"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an oversized stream before reporting successful verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chisel-oversize-"));
    const progress: DownloadProgress[] = [];
    const fetchImpl = (async () =>
      new Response("too many bytes")) as unknown as typeof fetch;
    try {
      await expect(
        downloadReleaseAsset("https://example.test/a", "a.exe", {
          fetchImpl,
          destDir: directory,
          expectedBytes: 4,
          onProgress: (value) => progress.push(value),
        }),
      ).rejects.toThrow("Размер");
      expect(progress.some((value) => value.phase === "verifying")).toBe(false);
      await expect(readFile(join(directory, "a.exe"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unknown download size stays unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chisel-unknown-"));
    const progress: DownloadProgress[] = [];
    const fetchImpl = (async () =>
      new Response("payload")) as unknown as typeof fetch;
    try {
      await downloadReleaseAsset("https://example.test/a", "a.exe", {
        fetchImpl,
        destDir: directory,
        onProgress: (value) => progress.push(value),
      });
      expect(progress.at(-1)?.bytes).toBe(7);
      expect(progress.every((value) => value.totalBytes === undefined)).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("aborted requests never start a download", async () => {
    const abort = new AbortController();
    abort.abort();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("payload");
    }) as unknown as typeof fetch;
    await expect(
      downloadReleaseAsset("https://example.test/a", "a.exe", {
        fetchImpl,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("an unwritable destination fails without hanging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chisel-disk-"));
    const fetchImpl = (async () =>
      new Response("payload")) as unknown as typeof fetch;
    try {
      await expect(
        downloadReleaseAsset("https://example.test/a", "a.exe", {
          fetchImpl,
          destDir: join(directory, "missing"),
        }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves Windows project paths with spaces without a shell", () => {
    expect(
      windowsUpdateArguments("C:\\Users\\user\\My project", "saved-123"),
    ).toEqual([
      "/S",
      "/CHISEL_CWD=C:\\Users\\user\\My project",
      "/CHISEL_RESUME=saved-123",
    ]);
    expect(windowsUpdateArguments("C:\\projects")).toEqual([
      "/S",
      "/CHISEL_CWD=C:\\projects",
    ]);
    expect(() => windowsUpdateArguments('C:\\bad"path')).toThrow("путь");
    expect(() => windowsUpdateArguments("C:\\projects", 'bad"id')).toThrow("ID");
  });

  test("rejects unsupported installer architectures", () => {
    const plan = planSelfUpdate(
      { current: "0.6.11", latest: "0.6.12", updateAvailable: true },
      "0.6.11",
      "linux",
      "arm64",
      "/usr/local/bin/chisel",
    );
    expect(plan.error).toContain("linux/arm64");
    const mac = planSelfUpdate(
      { current: "0.6.11", latest: "0.6.12", updateAvailable: true },
      "0.6.11",
      "darwin",
      "arm64",
      "/usr/local/bin/chisel",
    );
    expect(mac.asset).toContain("macos-arm64");
    expect(mac.error).toBeUndefined();
  });
});
