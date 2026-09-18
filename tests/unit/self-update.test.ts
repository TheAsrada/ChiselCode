import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import {
  checkAssetAvailable,
  compareVersions,
  downloadReleaseAsset,
  installerAssetName,
  isInstalledBinary,
  launchWindowsInstaller,
  manualInstallCommand,
  NSIS_SILENT_ARGS,
  normalizeVersion,
  planSelfUpdate,
  releaseDownloadUrl,
  type SelfUpdatePlan,
} from "../../src/commands/update.js";
import { createTuiApprovalResolver, TuiApp } from "../../src/ui/tui.js";

describe("self update helpers", () => {
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

type MockStdout = PassThrough & {
  columns: number;
  rows: number;
  isTTY: boolean;
};

type MockStdin = PassThrough & {
  isTTY: boolean;
  setRawMode(mode: boolean): void;
  ref(): unknown;
  unref(): unknown;
};

function createMockStdout(columns: number, rows: number): MockStdout {
  const stdout = new PassThrough() as MockStdout;
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  return stdout;
}

function createMockStdin(): MockStdin {
  const stdin = new PassThrough() as MockStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function stripAnsi(input: string): string {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const chunks = input.split(ESC);
  let result = chunks[0] ?? "";
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith("]")) {
      const end = chunk.indexOf(BEL);
      result += end === -1 ? "" : chunk.slice(end + 1);
      continue;
    }
    const csi = /^\[[0-9;?]*[A-Za-z]/.exec(chunk);
    if (csi) {
      result += chunk.slice(csi[0].length);
      continue;
    }
    if (
      chunk.startsWith("(") ||
      chunk.startsWith(")") ||
      chunk.startsWith("#")
    ) {
      result += chunk.slice(2);
      continue;
    }
    result += chunk.slice(1);
  }
  return result.replace(/\r/g, "");
}

const tick = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function availablePlan(): SelfUpdatePlan {
  return {
    current: "0.2.21",
    latest: "9.9.9",
    latestUrl: "https://example.test/releases",
    updateAvailable: true,
    asset: "ChiselCode-Setup-9.9.9.exe",
    url: "https://example.test/ChiselCode-Setup-9.9.9.exe",
    installedBinary: true,
    autoInstall: true,
  };
}

describe("tui self update flow", () => {
  test("reports already being on the latest version", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onPlanUpdate: async () => ({
          ...availablePlan(),
          latest: "0.2.21",
          updateAvailable: false,
        }),
        provider: "anthropic",
        providerLabel: "Anthropic (Claude)",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      for (const ch of "/update") {
        stdin.write(ch);
        await tick(20);
      }
      stdin.write("\r");
      await tick(400);
      expect(stripAnsi(output)).toContain("последняя версия");
    } finally {
      instance.unmount();
    }
  });

  test("confirms, downloads, launches and exits on approval", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const downloaded: string[] = [];
    const launched: { path: string; silent: boolean }[] = [];
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onPlanUpdate: async () => availablePlan(),
        onDownloadUpdate: async (plan) => {
          downloaded.push(plan.asset);
          return {
            path: "C:\\Temp\\ChiselCode-Setup-9.9.9.exe",
            bytes: 1048576,
          };
        },
        onLaunchInstaller: async (path, silent) => {
          launched.push({ path, silent });
        },
        provider: "anthropic",
        providerLabel: "Anthropic (Claude)",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      for (const ch of "/update") {
        stdin.write(ch);
        await tick(20);
      }
      stdin.write("\r");
      await tick(500);
      // Панель подтверждения обновления с подписью из TOOL_DISPLAY.
      expect(stripAnsi(output)).toContain("Обновление ChiselCode");
      stdin.write("y");
      await tick(600);
      expect(downloaded).toEqual(["ChiselCode-Setup-9.9.9.exe"]);
      expect(launched).toEqual([
        { path: "C:\\Temp\\ChiselCode-Setup-9.9.9.exe", silent: true },
      ]);
      let exited = false;
      await Promise.race([
        instance.waitUntilExit().then(() => {
          exited = true;
        }),
        tick(2000),
      ]);
      expect(exited).toBe(true);
    } finally {
      instance.unmount();
    }
  });

  test("approves with the Russian layout key", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const downloaded: string[] = [];
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onPlanUpdate: async () => availablePlan(),
        onDownloadUpdate: async (plan) => {
          downloaded.push(plan.asset);
          return {
            path: "C:\\Temp\\ChiselCode-Setup-9.9.9.exe",
            bytes: 1048576,
          };
        },
        onLaunchInstaller: async () => {},
        provider: "anthropic",
        providerLabel: "Anthropic (Claude)",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      for (const ch of "/update") {
        stdin.write(ch);
        await tick(20);
      }
      stdin.write("\r");
      await tick(500);
      expect(stripAnsi(output)).toContain("Обновление ChiselCode");
      // «н» — та же физическая клавиша, что y в русской раскладке.
      stdin.write("н");
      await tick(600);
      expect(downloaded).toEqual(["ChiselCode-Setup-9.9.9.exe"]);
    } finally {
      instance.unmount();
    }
  });
});
