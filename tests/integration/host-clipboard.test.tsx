/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { createHostClipboard, type TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { themePalette } from "../../src/ui/appearance.js";
import { OpenTuiClipboard } from "../../src/ui/opentui-clipboard.js";

// Desktop clipboard APIs are present on the macOS/Windows CI runners.
// Linux CI has no X11/Wayland display; renderer tests cover its terminal path.
test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
  "ChiselCode pastes Unicode from the native OS clipboard and copies selected text back",
  async () => {
    const clipboard = createHostClipboard({ timeoutMs: 3000 });
    const previous = await clipboard.read({ preferredTypes: ["text/plain"] });
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    try {
      const text = "ChiselCode clipboard smoke\nПривет 😀\tcode";
      expect((await clipboard.writeText(text)).status).toBe("written");
      const read = await clipboard.read({
        preferredTypes: ["text/plain"],
      });
      expect(read.status).toBe("read");
      // CF_UNICODETEXT uses CRLF; the ChiselCode editor must normalize it to LF.
      if (read.status === "read")
        expect(new TextDecoder().decode(read.representation.bytes)).toBe(
          process.platform === "win32" ? text.replace(/\n/g, "\r\n") : text,
        );
      setup = await testRender(
        <OpenTuiClipboard palette={themePalette("obsidian")}>
          <textarea id="native-clipboard-editor" focused height={3} />
        </OpenTuiClipboard>,
        { width: 80, height: 10, exitOnCtrlC: false },
      );
      const rendered = setup;
      await act(async () => rendered.renderOnce());
      const editor = rendered.renderer.root.findDescendantById(
        "native-clipboard-editor",
      ) as TextareaRenderable;
      await act(async () => {
        rendered.mockInput.pressKey("v", { ctrl: true });
        const deadline = Date.now() + 4000;
        while (editor.plainText !== text && Date.now() < deadline)
          await Bun.sleep(20);
        await rendered.renderOnce();
      });
      expect(editor.plainText).toBe(text);
      const start = text.indexOf("Привет");
      act(() => editor.setSelection(start, start + "Привет".length));
      expect(editor.getSelectedText()).toBe("Привет");
      await act(async () => {
        rendered.mockInput.pressKey("\u001b[2;5~");
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const copied = await clipboard.read({
            preferredTypes: ["text/plain"],
          });
          if (
            copied.status === "read" &&
            new TextDecoder().decode(copied.representation.bytes) === "Привет"
          )
            break;
          await Bun.sleep(20);
        }
        await rendered.renderOnce();
      });
      const copied = await clipboard.read({ preferredTypes: ["text/plain"] });
      expect(copied.status).toBe("read");
      if (copied.status === "read")
        expect(new TextDecoder().decode(copied.representation.bytes)).toBe(
          "Привет",
        );
      expect(editor.plainText).toBe(text);
      const noticeDeadline = Date.now() + 2000;
      while (
        !rendered.captureCharFrame().includes("Скопировано") &&
        Date.now() < noticeDeadline
      ) {
        await act(async () => Bun.sleep(20));
        await act(async () => rendered.renderOnce());
      }
      expect(rendered.captureCharFrame()).toContain("Скопировано");
    } finally {
      if (setup) act(() => setup?.renderer.destroy());
      if (previous.status === "read")
        await clipboard.writeText(
          new TextDecoder().decode(previous.representation.bytes),
        );
      else await clipboard.clear();
      await clipboard.dispose();
    }
  },
  15000,
);
