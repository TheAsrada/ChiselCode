import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { execa } from "execa";
import { zipSync } from "fflate";
import { act } from "react";
import { readExtensionRegistry } from "../../src/extensions/external/registry.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const phase = process.argv.indexOf("--phase");
if (phase < 0) {
  const storage = await mkdtemp(join(tmpdir(), "chisel-ext-settings-ui-"));
  try {
    await mkdir(join(storage, "project"));
    await writeFile(
      join(storage, "project/README.md"),
      "Настоящий README стороннего пакета\n",
    );
    await writeFile(
      join(storage, "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        ui: {
          theme: process.env.CHISEL_EXTENSION_SETTINGS_THEME ?? "obsidian",
        },
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    await cp(
      resolve("tests/fixtures/extensions/settings-demo"),
      join(storage, "author"),
      { recursive: true },
    );
    const manifest = JSON.parse(
      await readFile(join(storage, "author/chisel-extension.json"), "utf8"),
    );
    manifest.version = "1.1.0";
    await writeFile(
      join(storage, "update.zip"),
      zipSync({
        "chisel-extension.json": Buffer.from(JSON.stringify(manifest)),
        "index.mjs": await readFile(join(storage, "author/index.mjs")),
      }),
    );
    for (const step of ["install", "use", "update", "disabled"]) {
      const args = /(?:^|[/\\])bun(?:\.exe)?$/i.test(process.execPath)
        ? [resolve(import.meta.path), "--phase", step, storage]
        : ["--phase", step, storage];
      await execa(process.execPath, args, {
        stdio: "inherit",
        env: {
          XDG_DATA_HOME: join(storage, "home"),
          XDG_CONFIG_HOME: join(storage, "home"),
          APPDATA: join(storage, "home"),
          LOCALAPPDATA: join(storage, "home"),
          CHISEL_DEMO_IMPORTS: join(storage, "imports.txt"),
        },
      });
    }
    console.log(
      "Настоящий OpenTUI: папка/ZIP, review/cancel, trust, restart, tool/command, settings, update/rollback, disable/remove; модель не вызывалась.",
    );
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
} else {
  const step = process.argv[phase + 1]!,
    storage = process.argv[phase + 2]!,
    project = join(storage, "project"),
    configPath = join(storage, "config.json");
  const ui = await createTestRenderer({
    width: 160,
    height: 50,
    exitOnCtrlC: false,
  });
  let application: Promise<void> | undefined,
    fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: Parameters<typeof fetch>[0]) => {
    const url = String(request instanceof Request ? request.url : request);
    if (!url.includes("api.github.com")) fetches++;
    throw new Error("Model/network запрещены в пассивном сценарии расширений.");
  }) as unknown as typeof fetch;
  const frame = async () => {
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await Bun.sleep(10);
        await ui.renderOnce();
      });
  };
  const until = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(`${label}\n${ui.captureCharFrame()}`);
      await frame();
    }
  };
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      ui.mockInput.pressKey(
        name as Parameters<typeof ui.mockInput.pressKey>[0],
        { ctrl },
      );
      if (name === "ESCAPE") await Bun.sleep(120);
    });
    await frame();
  };
  const click = async (id: string) => {
    // React can mount a node before OpenTUI has rebuilt its native hit map.
    await frame();
    const node = ui.renderer.root.findDescendantById(id);
    assert.ok(node, `Нет ${id}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await ui.mockMouse.click(node.x + 1, node.y);
    });
    await frame();
  };
  const paste = async (value: string) => {
    await act(async () => ui.mockInput.pasteBracketedText(value));
    await frame();
  };
  const capture = async (name: string) => {
    const folder = process.env.CHISEL_EXTENSION_SETTINGS_CAPTURES;
    if (!folder) return;
    await frame();
    await mkdir(folder, { recursive: true });
    const spans = ui.captureSpans();
    await writeFile(join(folder, `${name}.txt`), ui.captureCharFrame());
    await writeFile(
      join(folder, `${name}.json`),
      JSON.stringify({
        ...spans,
        lines: spans.lines.map((line) => ({
          spans: line.spans.map((span) => ({
            ...span,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
          })),
        })),
      }),
    );
  };
  const settings = async () => {
    await key("t", true);
    await until(
      () => !!ui.renderer.root.findDescendantById("settings-popup"),
      "Нет настроек",
    );
    await click("settings-route-extensions");
    await until(
      () => !!ui.renderer.root.findDescendantById("extensions-install"),
      "Нет каталога",
    );
  };
  const select = async () => {
    await until(
      () =>
        !!ui.renderer.root.findDescendantById(
          "extensions-item-example.settings-demo",
        ),
      "Нет пакета",
    );
    await click("extensions-item-example.settings-demo");
    await until(
      () =>
        !!ui.renderer.root.findDescendantById("extensions-action-remove") &&
        !ui.captureCharFrame().includes("Выполняется"),
      "Клик не открыл карточку пакета",
    );
  };
  const command = async (expected: string) => {
    await click("prompt-editor");
    const editor = ui.renderer.currentFocusedEditor as
      | { plainText?: string }
      | undefined;
    const length = [...(editor?.plainText ?? "")].length;
    await key("END");
    for (let i = 0; i < length; i++) await key("BACKSPACE");
    await paste("/demo-settings");
    await key("RETURN");
    await until(
      () => ui.captureCharFrame().includes(expected),
      "Команда/инструмент не отработали",
    );
  };
  try {
    await act(async () => {
      application = runOpenTuiAgent(
        { cwd: project, configPath },
        undefined,
        false,
        false,
        undefined,
        async () => ui.renderer,
      );
    });
    await until(
      () => !!ui.renderer.root.findDescendantById("welcome"),
      "Нет ordinary OpenTUI",
    );
    if (step === "install") {
      await click("prompt-editor");
      await paste("Черновик перед расширениями");
      await settings();
      await capture("catalog-160x50");
      await click("extensions-install");
      await paste(join(storage, "author"));
      await key("RETURN");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-trust"),
        "Нет review",
      );
      await capture("install-review-160x50");
      await key("ESCAPE");
      assert.equal(
        (await readExtensionRegistry()).records.length,
        0,
        "Отмена создала пакет",
      );
      await click("extensions-install");
      await paste(join(storage, "author"));
      await key("RETURN");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-commit"),
        "Нет review 2",
      );
      await key("RETURN");
      await select();
      assert.equal((await readExtensionRegistry()).records[0]?.enabled, false);
      assert.equal(
        await Bun.file(join(storage, "imports.txt")).exists(),
        false,
      );
      await capture("installed-untrusted-160x50");
      await key("t");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-trust"),
        "Нет trust review",
      );
      await key("t");
      await key("RETURN");
      await until(
        () => ui.captureCharFrame().includes("Нужен перезапуск"),
        "Нет pending restart",
      );
      await key("ESCAPE");
      assert.match(ui.captureCharFrame(), /Черновик перед расширениями/);
    } else if (step === "use") {
      // React can mount `welcome` before the native frame buffer has painted.
      // Wait for the actual restored draft; an absent draft still fails the scenario.
      await until(
        () => ui.captureCharFrame().includes("Черновик перед расширениями"),
        "Перезапуск не отобразил сохранённый черновик",
      );
      assert.match(
        ui.captureCharFrame(),
        /Черновик перед расширениями/,
        "Перезапуск потерял черновик",
      );
      await command("Привет · Привет");
      await settings();
      await select();
      await capture("working-160x50");
      await key("s");
      await until(
        () =>
          !!ui.renderer.root.findDescendantById("extensions-setting-message"),
        "Нет формы",
      );
      await click("extensions-setting-message");
      await key("END");
      for (let i = 0; i < 6; i++) await key("BACKSPACE");
      await paste("После restart");
      await key("RETURN");
      await key("F2");
      await until(
        () => ui.captureCharFrame().includes("Параметры расширения применятся"),
        "Параметры не сохранены",
      );
      await capture("settings-160x50");
      await key("ESCAPE");
      await key("ESCAPE");
    } else if (step === "update") {
      await command("После restart · После restart");
      await settings();
      await select();
      await key("u");
      await paste(join(storage, "update.zip"));
      await key("RETURN");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-trust"),
        "Нет update review",
      );
      await capture("update-review-160x50");
      await key("t");
      await key("RETURN");
      await until(
        () =>
          !!ui.renderer.root.findDescendantById("extensions-action-versions") &&
          !ui.captureCharFrame().includes("Выполняется"),
        "Update не выбран",
      );
      await key("v");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-version-0"),
        "Нет версий",
      );
      await capture("versions-160x50");
      await click("extensions-version-0");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-commit"),
        "Нет rollback review",
      );
      await key("RETURN");
      await until(
        () =>
          !!ui.renderer.root.findDescendantById("extensions-action-disable") &&
          !ui.captureCharFrame().includes("Выполняется"),
        "Нет карточки после rollback",
      );
      await key("e");
      await until(
        () =>
          !!ui.renderer.root.findDescendantById("extensions-action-enable") &&
          !ui.captureCharFrame().includes("Выполняется"),
        "Нет disable",
      );
      assert.equal((await readExtensionRegistry()).records[0]?.enabled, false);
      await capture("disabled-before-restart-160x50");
      for (const [width, height] of [
        [80, 24],
        [40, 16],
        [24, 8],
      ]) {
        await act(async () => ui.resize(width!, height!));
        await frame();
        await capture(`catalog-${width}x${height}`);
      }
    } else {
      await settings();
      await select();
      assert.equal(
        await readFile(join(storage, "imports.txt"), "utf8"),
        "import\nimport\n",
        "Выключенная версия была импортирована",
      );
      await key("DELETE");
      await until(
        () => !!ui.renderer.root.findDescendantById("extensions-commit"),
        "Нет remove review",
      );
      await key("RETURN");
      await until(
        () =>
          !!ui.renderer.root.findDescendantById("extensions-install") &&
          !ui.captureCharFrame().includes("Выполняется"),
        "Remove не завершён",
      );
      await capture("removed-160x50");
      assert.ok((await readExtensionRegistry()).records[0]?.removedAt);
    }
    assert.equal(fetches, 0, "Настройки/команда вызвали сеть/модель");
  } finally {
    if (application) {
      process.emit("SIGTERM");
      await application;
    }
    ui.renderer.destroy();
    globalThis.fetch = originalFetch;
  }
}
