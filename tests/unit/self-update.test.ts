import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import {
  downloadReleaseAsset,
  installerAssetName,
  isInstalledBinary,
  manualInstallCommand,
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

  test("passes check errors through to the plan", () => {
    const plan = planSelfUpdate(
      { current: "0.2.21", error: "Нет соединения" },
      "0.2.21",
      "win32",
    );
    expect(plan.updateAvailable).toBe(false);
    expect(plan.error).toBe("Нет соединения");
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
    const launched: string[] = [];
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
        onLaunchInstaller: async (path) => {
          launched.push(path);
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
      expect(launched).toEqual(["C:\\Temp\\ChiselCode-Setup-9.9.9.exe"]);
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
});
