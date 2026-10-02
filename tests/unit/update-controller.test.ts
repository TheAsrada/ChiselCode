import { describe, expect, test } from "bun:test";
import {
  planSelfUpdate,
  type UpdateCheckResult,
} from "../../src/commands/update.js";
import {
  UpdateController,
  type UpdateDependencies,
} from "../../src/ui/update-controller.js";

const release: UpdateCheckResult = {
  current: "0.6.11",
  latest: "0.6.12",
  updateAvailable: true,
  assets: [
    {
      name: "ChiselCode-Setup-0.6.12.exe",
      url: "https://example.test/update.exe",
      size: 1024,
      sha256: "f".repeat(64),
    },
  ],
};

function fixture(overrides: Partial<UpdateDependencies> = {}) {
  const calls = {
    checks: 0,
    downloads: 0,
    launches: 0,
    removed: [] as string[],
  };
  const updater = new UpdateController("0.6.11", {
    check: async () => {
      calls.checks++;
      return release;
    },
    plan: (check, current) =>
      planSelfUpdate(check, current, "win32", "x64", "C:/app/chisel.exe"),
    download: async (_url, _asset, options) => {
      calls.downloads++;
      options.onProgress?.({
        phase: "downloading",
        bytes: 512,
        totalBytes: 1024,
      });
      options.onProgress?.({
        phase: "verifying",
        bytes: 1024,
        totalBytes: 1024,
      });
      return { path: "/temporary/update.exe", bytes: 1024 };
    },
    launch: async () => {
      calls.launches++;
    },
    remove: async (downloaded) => {
      calls.removed.push(downloaded.path);
    },
    now: () => 0,
    ...overrides,
  });
  return { updater, calls };
}

describe("application updater", () => {
  test("background checks are cached and never download or install", async () => {
    const { updater, calls } = fixture();
    await updater.check();
    await updater.check();
    expect(updater.snapshot.phase).toBe("available");
    expect(calls).toEqual({
      checks: 1,
      downloads: 0,
      launches: 0,
      removed: [],
    });
    await updater.check(true);
    expect(calls.checks).toBe(2);
    await updater.dispose();
  });

  test("concurrent checks share one operation", async () => {
    let finish: ((check: UpdateCheckResult) => void) | undefined;
    let checks = 0;
    const { updater } = fixture({
      check: () => {
        checks++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const first = updater.check();
    const second = updater.check(true);
    expect(checks).toBe(1);
    finish?.(release);
    await Promise.all([first, second]);
    expect(updater.snapshot.phase).toBe("available");
    await updater.dispose();
  });

  test("cancellation prevents a late check from overwriting a newer result", async () => {
    const finishes: Array<(check: UpdateCheckResult) => void> = [];
    const { updater } = fixture({
      check: () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    });
    const old = updater.check();
    updater.cancel();
    const latest = updater.check();
    finishes[1]?.({
      current: "0.6.11",
      latest: "0.6.11",
      updateAvailable: false,
    });
    await latest;
    finishes[0]?.(release);
    await old;
    expect(updater.snapshot.phase).toBe("current");
    expect(updater.snapshot.plan?.latest).toBe("0.6.11");
    await updater.dispose();
  });

  test("network failures can be retried without an application restart", async () => {
    let checks = 0;
    const { updater } = fixture({
      check: async () => {
        if (++checks === 1) throw new Error("Network unavailable");
        return release;
      },
    });
    await updater.check();
    expect(updater.snapshot.error).toBe("Network unavailable");
    await updater.check();
    expect(updater.snapshot.phase).toBe("available");
    expect(updater.snapshot.error).toBeUndefined();
    await updater.dispose();
  });

  test("a release without a published installer never downloads", async () => {
    const { updater, calls } = fixture({
      check: async () => ({ ...release, assets: [] }),
    });
    await updater.check();
    expect(updater.snapshot.phase).toBe("unavailable");
    await updater.prepare();
    expect(calls.downloads).toBe(0);
    expect(calls.launches).toBe(0);
    await updater.dispose();
  });

  test("missing checksums stop an update before download", async () => {
    const { updater, calls } = fixture({
      check: async () => ({
        ...release,
        assets: release.assets?.map((asset) => ({
          ...asset,
          sha256: undefined,
        })),
      }),
    });
    await updater.check();
    await updater.prepare();
    expect(updater.snapshot.error).toContain("SHA-256");
    expect(calls.downloads).toBe(0);
    await updater.dispose();
  });

  test("running from sources cannot replace the runtime", async () => {
    const { updater, calls } = fixture({
      plan: (check, current) =>
        planSelfUpdate(check, current, "win32", "x64", "/opt/bun/bun"),
    });
    await updater.check();
    await updater.prepare();
    expect(updater.snapshot.plan?.installedBinary).toBe(false);
    expect(calls.downloads).toBe(0);
    expect(calls.launches).toBe(0);
    await updater.dispose();
  });

  test("a verified update waits for an explicit restart and is not downloaded twice", async () => {
    const { updater, calls } = fixture();
    const phases: string[] = [];
    updater.subscribe((state) => phases.push(state.phase));
    await updater.check();
    await updater.prepare();
    expect(updater.snapshot.phase).toBe("ready");
    expect(updater.snapshot.bytes).toBe(1024);
    expect(phases).toContain("downloading");
    expect(phases).toContain("verifying");
    expect(calls.launches).toBe(0);
    await updater.check(true);
    await updater.prepare();
    expect(calls.downloads).toBe(1);
    await updater.restart();
    expect(calls.launches).toBe(1);
    await updater.restart();
    expect(calls.launches).toBe(1);
    await updater.dispose();
    expect(calls.removed).toEqual([]);
  });

  test("a cancelled download cleans up a late verified file", async () => {
    let finish: ((value: { path: string; bytes: number }) => void) | undefined;
    let signal: AbortSignal | undefined;
    const { updater, calls } = fixture({
      download: (_url, _asset, options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await updater.check();
    const downloading = updater.prepare();
    await updater.restart();
    updater.cancel();
    expect(signal?.aborted).toBe(true);
    finish?.({ path: "/temporary/late.exe", bytes: 1024 });
    await downloading;
    expect(updater.snapshot.phase).toBe("cancelled");
    expect(updater.snapshot.downloaded).toBeUndefined();
    expect(calls.removed).toEqual(["/temporary/late.exe"]);
    expect(calls.launches).toBe(0);
    await updater.dispose();
  });

  test("integrity errors cannot launch an installer and allow retry", async () => {
    let attempts = 0;
    const { updater, calls } = fixture({
      download: async () => {
        if (++attempts === 1) throw new Error("Контрольная сумма не совпадает");
        return { path: "/temporary/retry.exe", bytes: 1024 };
      },
    });
    await updater.check();
    await updater.prepare();
    expect(updater.snapshot.phase).toBe("error");
    await updater.restart();
    expect(calls.launches).toBe(0);
    await updater.prepare();
    expect(updater.snapshot.phase).toBe("ready");
    expect(updater.snapshot.error).toBeUndefined();
    await updater.dispose();
    expect(calls.removed).toEqual(["/temporary/retry.exe"]);
  });

  test("restart is blocked while an agent request or queue is active", async () => {
    let canRestart = false;
    const { updater, calls } = fixture({ canRestart: () => canRestart });
    await updater.check();
    await updater.prepare();
    await updater.restart();
    expect(calls.launches).toBe(0);
    expect(updater.snapshot.phase).toBe("ready");
    expect(updater.snapshot.error).toContain("завершения запроса");
    canRestart = true;
    await updater.restart();
    expect(calls.launches).toBe(1);
    await updater.dispose();
  });

  test("a launch failure keeps the verified installer for retry", async () => {
    let attempts = 0;
    const { updater, calls } = fixture({
      launch: async () => {
        if (++attempts === 1) throw new Error("Installer blocked");
      },
    });
    await updater.check();
    await updater.prepare();
    await updater.restart();
    expect(updater.snapshot.phase).toBe("ready");
    expect(updater.snapshot.error).toBe("Installer blocked");
    await updater.restart();
    expect(attempts).toBe(2);
    expect(calls.downloads).toBe(1);
    await updater.dispose();
    expect(calls.removed).toEqual([]);
  });

  test("manual installation uses the actual downloaded path on every host OS", async () => {
    const macRelease = {
      ...release,
      assets: release.assets?.map((asset) => ({
        ...asset,
        name: "ChiselCode-Setup-0.6.12-macos-arm64.pkg",
      })),
    };
    const { updater, calls } = fixture({
      check: async () => macRelease,
      plan: (check, current) =>
        planSelfUpdate(
          check,
          current,
          "darwin",
          "arm64",
          "/usr/local/bin/chisel",
        ),
    });
    await updater.check();
    await updater.prepare();
    expect(updater.snapshot.plan?.manualCommand).toContain(
      'installer -pkg "/temporary/update.exe"',
    );
    await updater.restart();
    expect(calls.launches).toBe(0);
    await updater.dispose();
    expect(calls.removed).toEqual([]);
  });
});
