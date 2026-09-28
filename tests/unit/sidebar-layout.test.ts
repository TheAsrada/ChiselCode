import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/load.js";
import {
  parseSidebarMode,
  sidebarLayout,
  toggleSidebarMode,
} from "../../src/ui/sidebar-layout.js";

test("responsive sidebar reserves exactly 41 columns when the feed fits", () => {
  expect(sidebarLayout(60, "auto").placement).toBe("hidden");
  expect(sidebarLayout(80, "show").placement).toBe("overlay");
  expect(sidebarLayout(60, "show").placement).toBe("fullscreen");
  expect(sidebarLayout(120, "auto")).toEqual({
    placement: "inline",
    feedWidth: 79,
    sidebarWidth: 40,
  });
  expect(sidebarLayout(160, "auto").feedWidth).toBe(119);
  expect(sidebarLayout(120, "hide").placement).toBe("hidden");
  expect(sidebarLayout(80, "show", true).placement).toBe("hidden");
});

test("sidebar choice survives a config reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-sidebar-"));
  try {
    const path = join(root, "config.json");
    await saveGlobalConfig(
      { providers: {}, ui: { sidebarMode: "show" } },
      path,
    );
    expect((await loadGlobalConfig(path)).ui?.sidebarMode).toBe("show");
    await saveGlobalConfig(
      { ...(await loadGlobalConfig(path)), ui: { sidebarMode: "auto" } },
      path,
    );
    expect((await loadGlobalConfig(path)).ui?.sidebarMode).toBe("auto");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Ctrl+B and /sidebar use the same mode choices", () => {
  expect(toggleSidebarMode("auto", 80)).toBe("show");
  expect(toggleSidebarMode("auto", 120)).toBe("hide");
  expect(toggleSidebarMode("show", 80)).toBe("hide");
  expect(parseSidebarMode(" AUTO ")).toBe("auto");
  expect(parseSidebarMode("invalid")).toBeUndefined();
});
