/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type {
  ClipboardService,
  InputRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { themePalette } from "../../src/ui/appearance.js";
import { OpenTuiClipboard } from "../../src/ui/opentui-clipboard.js";
import { DialogAction, OpenTuiDialog } from "../../src/ui/opentui-dialog.js";
import { SettingsSecretInput } from "../../src/ui/opentui-settings-input.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TerminalClipboardController } from "../../src/ui/terminal-clipboard.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

function memoryClipboard(initial = "") {
  let text = initial;
  const written: string[] = [];
  let reads = 0;
  const service: ClipboardService = {
    read: async () => {
      reads++;
      return {
        status: "read",
        representation: {
          mimeType: "text/plain",
          bytes: new TextEncoder().encode(text),
        },
      };
    },
    writeText: async (next) => {
      written.push(next);
      text = next;
      return {
        host: { status: "written" },
        terminal: { status: "not-attempted", capability: "unknown" },
      };
    },
    clear: async () => ({
      host: { status: "cleared" },
      terminal: { status: "not-attempted", capability: "unknown" },
    }),
    dispose: async () => {},
  };
  return {
    service,
    written,
    get text() {
      return text;
    },
    get reads() {
      return reads;
    },
  };
}
type Setup = Awaited<ReturnType<typeof testRender>>;
const editor = (setup: Setup) =>
  setup.renderer.root.findDescendantById("prompt-editor") as TextareaRenderable;
const frame = (setup: Setup) =>
  act(async () => {
    await setup.renderOnce();
  });
async function key(setup: Setup, name: string, ctrl = false, shift = false) {
  await act(async () => {
    setup.mockInput.pressKey(name, { ctrl, shift });
    await Bun.sleep(5);
  });
  await frame(setup);
}
const destroy = (setup: Setup) => act(() => setup.renderer.destroy());

for (const classic of [false, true]) {
  test(`clipboard paste uses the native editor, preserves Unicode and never submits (classic=${classic})`, async () => {
    const clipboard = memoryClipboard("Привет\r\nвторая строка\r😀\tcode");
    const controller = new TuiController(process.cwd());
    let submitted = 0;
    const setup = await testRender(
      <OpenTuiSpike
        controller={controller}
        clipboard={clipboard.service}
        classic={classic}
        onExit={() => {}}
        onSubmit={async () => {
          submitted++;
        }}
      />,
      { width: 80, height: 24, exitOnCtrlC: false },
    );
    try {
      await frame(setup);
      await key(setup, "v", true);
      expect(editor(setup).plainText).toBe("Привет\nвторая строка\n😀\tcode");
      expect(controller.snapshot.draft).toBe(editor(setup).plainText);
      expect(submitted).toBe(0);
      expect(clipboard.reads).toBe(1);
      await act(async () => editor(setup).undo());
      expect(editor(setup).plainText).toBe("");
      await act(async () => editor(setup).redo());
      expect(editor(setup).plainText).toBe("Привет\nвторая строка\n😀\tcode");
      await act(async () => editor(setup).setText("abcDEFghi"));
      act(() => editor(setup).setSelection(3, 6));
      await key(setup, "\u001b[2;2~");
      expect(editor(setup).plainText).toBe(
        "abcПривет\nвторая строка\n😀\tcodeghi",
      );
    } finally {
      destroy(setup);
      controller.dispose();
    }
  });
}

test("terminal bracketed paste removes controls and CRLF without a second clipboard read", async () => {
  const clipboard = memoryClipboard("must not be read");
  const setup = await testRender(
    <OpenTuiSpike clipboard={clipboard.service} onExit={() => {}} />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await act(async () =>
      setup.mockInput.pasteBracketedText(
        "\u001b[31mПривет\u001b[0m\r\nмир\u0000\u0007",
      ),
    );
    await frame(setup);
    expect(editor(setup).plainText).toBe("Привет\nмир");
    expect(clipboard.reads).toBe(0);
  } finally {
    destroy(setup);
  }
});

test("Ctrl+Shift+V restores composer focus and reads the clipboard once", async () => {
  const clipboard = memoryClipboard("задача");
  const setup = await testRender(
    <OpenTuiSpike clipboard={clipboard.service} onExit={() => {}} />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await key(setup, "TAB");
    expect(editor(setup).focused).toBe(false);
    await key(setup, "\u001b[118;6u");
    expect(editor(setup).plainText).toBe("задача");
    expect(editor(setup).focused).toBe(true);
    expect(clipboard.reads).toBe(1);
  } finally {
    destroy(setup);
  }
});

test("mouse selection inside the composer does not overwrite the incoming clipboard", async () => {
  const clipboard = memoryClipboard("replacement");
  const setup = await testRender(
    <OpenTuiSpike clipboard={clipboard.service} onExit={() => {}} />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    act(() => editor(setup).setText("abcDEFghi"));
    await frame(setup);
    const input = editor(setup);
    await act(async () => {
      await setup.mockMouse.drag(input.x + 3, input.y, input.x + 5, input.y);
      await Bun.sleep(5);
    });
    expect(input.getSelectedText()).toBe("DEF");
    expect(clipboard.text).toBe("replacement");
    expect(clipboard.written).toEqual([]);
    await key(setup, "v", true);
    expect(input.plainText).toBe("abcreplacementghi");
  } finally {
    destroy(setup);
  }
});

test("right-click pastes once and cannot send a draft or switch modes", async () => {
  const clipboard = memoryClipboard("вставка");
  let submitted = 0;
  const controller = new TuiController(process.cwd());
  const setup = await testRender(
    <OpenTuiSpike
      clipboard={clipboard.service}
      controller={controller}
      onExit={() => {}}
      onSubmit={async () => {
        submitted++;
      }}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await act(async () => {
      const input = editor(setup);
      await setup.mockMouse.click(input.x + 1, input.y, 2);
      await Bun.sleep(5);
    });
    await frame(setup);
    expect(editor(setup).plainText).toBe("вставка");
    expect(clipboard.reads).toBe(1);
    const mode = controller.snapshot.agentMode;
    for (const id of [
      "prompt-send",
      "prompt-agent-mode",
      "prompt-permissions",
      "prompt-model",
    ]) {
      await act(async () => {
        const target = setup.renderer.root.findDescendantById(id);
        expect(target).toBeDefined();
        if (!target) throw new Error(`Missing ${id}`);
        await setup.mockMouse.click(target.x + 1, target.y, 2);
        await Bun.sleep(5);
      });
      await frame(setup);
    }
    expect(submitted).toBe(0);
    expect(controller.snapshot.agentMode).toBe(mode);
    expect(controller.snapshot.overlay).toBeUndefined();
  } finally {
    destroy(setup);
    controller.dispose();
  }
});

test("chat mouse selection copies Unicode, right-click copies and Ctrl+C still cancels", async () => {
  const clipboard = memoryClipboard("old");
  const controller = new TuiController(process.cwd());
  controller.append("Привет мир", "assistant");
  let cancelled = 0;
  const setup = await testRender(
    <OpenTuiSpike
      clipboard={clipboard.service}
      controller={controller}
      onExit={() => {}}
      onCancel={() => {
        cancelled++;
      }}
    />,
    { width: 80, height: 24, exitOnCtrlC: false },
  );
  try {
    await frame(setup);
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Привет мир"));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = (lines[y] ?? "").indexOf("Привет мир");
    await act(async () => {
      await setup.mockMouse.drag(x, y, x + 5, y);
      await Bun.sleep(5);
    });
    await frame(setup);
    expect(clipboard.text).toBe("Привет");
    await key(setup, "\u001b[99;6u");
    expect(cancelled).toBe(0);
    expect(clipboard.written.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      await setup.mockMouse.click(x, y, 2);
      await Bun.sleep(5);
    });
    await frame(setup);
    expect(setup.renderer.hasSelection).toBe(false);
    expect(clipboard.text).toBe("Привет");
    await key(setup, "c", true);
    expect(cancelled).toBe(1);
  } finally {
    destroy(setup);
    controller.dispose();
  }
});

test("selecting draft text keeps incoming clipboard contents and Ctrl+Insert copies only the selection", async () => {
  const clipboard = memoryClipboard("replacement");
  const setup = await testRender(
    <OpenTuiSpike clipboard={clipboard.service} onExit={() => {}} />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    act(() => {
      editor(setup).setText("abcDEFghi");
      editor(setup).setSelection(3, 6);
    });
    await key(setup, "\u001b[2;5~");
    expect(clipboard.text).toBe("DEF");
    expect(editor(setup).plainText).toBe("abcDEFghi");
    await key(setup, "v", true);
    expect(editor(setup).plainText).toBe("abcDEFghi");
    expect(clipboard.reads).toBe(1);
  } finally {
    destroy(setup);
  }
});

test("native paste reaches masked credential editing and replaces its selection without revealing the secret", async () => {
  const clipboard = memoryClipboard("sk-Ж123");
  let secret = "abcdef";
  function Harness() {
    const [value, setValue] = useState(secret);
    return (
      <OpenTuiClipboard
        clipboard={clipboard.service}
        palette={themePalette("obsidian")}
      >
        <SettingsSecretInput
          value={value}
          onChange={(next) => {
            secret = next;
            setValue(next);
          }}
          onSubmit={() => {}}
          palette={themePalette("obsidian")}
        />
      </OpenTuiClipboard>
    );
  }
  const setup = await testRender(<Harness />, { width: 80, height: 10 });
  try {
    await frame(setup);
    const input = setup.renderer.root.findDescendantById(
      "settings-secret",
    ) as InputRenderable;
    act(() => input.setSelection(1, 4));
    await key(setup, "v", true);
    expect(secret).toBe("ask-Ж123ef");
    expect(input.value).toBe("*".repeat([...secret].length));
    expect(setup.captureCharFrame()).not.toContain("sk-Ж123");
    await act(async () => {
      await setup.mockMouse.click(input.x + 1, input.y, 2);
      await Bun.sleep(5);
    });
    await frame(setup);
    expect(clipboard.reads).toBe(2);
    expect(setup.captureCharFrame()).not.toContain("sk-Ж123");
  } finally {
    destroy(setup);
  }
});

test("right-click in a popup pastes into its input without approving or dismissing it", async () => {
  const clipboard = memoryClipboard("https://example.com/v1");
  let approved = 0,
    closed = 0;
  const palette = themePalette("obsidian");
  const setup = await testRender(
    <OpenTuiClipboard clipboard={clipboard.service} palette={palette}>
      <OpenTuiDialog
        id="copy-test"
        width={80}
        height={24}
        palette={palette}
        popupWidth={50}
        popupHeight={12}
        onClose={() => {
          closed++;
        }}
      >
        <input id="field" focused height={1} />
        <DialogAction
          id="allow"
          label="Разрешить"
          onSelect={() => {
            approved++;
          }}
          palette={palette}
        />
      </OpenTuiDialog>
    </OpenTuiClipboard>,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    const input = setup.renderer.root.findDescendantById(
      "field",
    ) as InputRenderable;
    const button = setup.renderer.root.findDescendantById("allow");
    if (!button) throw new Error("Missing approval button");
    await act(async () => {
      await setup.mockMouse.click(input.x + 1, input.y, 2);
      await Bun.sleep(5);
    });
    await frame(setup);
    expect(input.value).toBe("https://example.com/v1");
    await act(async () => {
      await setup.mockMouse.click(button.x + 1, button.y, 2);
      await setup.mockMouse.click(1, 1, 2);
      await Bun.sleep(5);
    });
    await frame(setup);
    expect(approved).toBe(0);
    expect(closed).toBe(0);
  } finally {
    destroy(setup);
  }
});

test("delayed clipboard reads are cancelled when switching tabs and never enter another draft", async () => {
  const clipboard = memoryClipboard();
  let complete!: (value: Awaited<ReturnType<ClipboardService["read"]>>) => void;
  let signal: AbortSignal | undefined;
  clipboard.service.read = (options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const workspace = new TuiWorkspace(process.cwd());
  workspace.newTab();
  const first = workspace.tabs[0];
  workspace.newTab();
  const second = workspace.tabs[1];
  if (!first || !second) throw new Error("Missing test tabs");
  workspace.select(first.key);
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      clipboard={clipboard.service}
      onExit={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await key(setup, "v", true);
    expect(complete).toBeDefined();
    await act(async () => workspace.select(second.key));
    await frame(setup);
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      complete({
        status: "read",
        representation: {
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("late secret"),
        },
      }),
    );
    await frame(setup);
    expect(editor(setup).plainText).toBe("");
    expect(first.controller.snapshot.draft).toBe("");
    expect(second.controller.snapshot.draft).toBe("");
  } finally {
    destroy(setup);
    workspace.dispose();
  }
});

test("clipboard failures are nonfatal and never display clipboard content in errors or transcript", async () => {
  const clipboard = memoryClipboard();
  clipboard.service.read = async () => {
    throw new Error("private-clipboard-content");
  };
  const controller = new TuiController(process.cwd());
  const setup = await testRender(
    <OpenTuiSpike
      controller={controller}
      clipboard={clipboard.service}
      onExit={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await key(setup, "v", true);
    expect(setup.captureCharFrame()).toContain("Не удалось прочитать буфер");
    expect(setup.captureCharFrame()).not.toContain("private-clipboard-content");
    expect(controller.snapshot.transcript).toEqual([]);
    await key(setup, "X");
    expect(editor(setup).plainText).toBe("X");
  } finally {
    destroy(setup);
    controller.dispose();
  }
});

test("Ctrl+C cancels a pending clipboard read while preserving request cancellation", async () => {
  const clipboard = memoryClipboard();
  let finish!: (value: Awaited<ReturnType<ClipboardService["read"]>>) => void;
  let signal: AbortSignal | undefined;
  clipboard.service.read = (options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  let cancelled = 0;
  const setup = await testRender(
    <OpenTuiSpike
      clipboard={clipboard.service}
      onExit={() => {}}
      onCancel={() => {
        cancelled++;
      }}
    />,
    { width: 80, height: 24, exitOnCtrlC: false },
  );
  try {
    await frame(setup);
    await key(setup, "v", true);
    await key(setup, "c", true);
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(1);
    await act(async () =>
      finish({
        status: "read",
        representation: {
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("late text"),
        },
      }),
    );
    await frame(setup);
    expect(editor(setup).plainText).toBe("");
  } finally {
    destroy(setup);
  }
});

test("SSH paste uses terminal-provided text and never reads the remote machine's clipboard", async () => {
  const clipboard = memoryClipboard("remote host private text");
  const setup = await testRender(<input id="ssh-input" focused height={1} />, {
    width: 80,
    height: 10,
  });
  const messages: string[] = [];
  const controller = new TerminalClipboardController(
    setup.renderer,
    (message) => messages.push(message),
    clipboard.service,
    () => true,
  );
  const detach = controller.attach();
  try {
    await frame(setup);
    await key(setup, "v", true);
    expect(clipboard.reads).toBe(0);
    expect(messages.join(" ")).toContain("Ctrl+Shift+V");
    await act(async () =>
      setup.mockInput.pasteBracketedText("локальный текст"),
    );
    await frame(setup);
    const input = setup.renderer.root.findDescendantById(
      "ssh-input",
    ) as InputRenderable;
    expect(input.value).toBe("локальный текст");
  } finally {
    detach();
    destroy(setup);
  }
});
