import { expect, test } from "bun:test";
import { createHostClipboard } from "@opentui/core";

// Desktop clipboard APIs are present on the macOS/Windows CI runners.
// Linux CI has no X11/Wayland display; renderer tests cover its terminal path.
test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
  "native OS clipboard writes and reads Unicode without shell helpers",
  async () => {
    const clipboard = createHostClipboard({ timeoutMs: 3000 });
    const previous = await clipboard.read({ preferredTypes: ["text/plain"] });
    try {
      const text = "ChiselCode clipboard smoke\nПривет 😀\tcode";
      expect((await clipboard.writeText(text)).status).toBe("written");
      const read = await clipboard.read({
        preferredTypes: ["text/plain;charset=utf-8", "text/plain"],
      });
      expect(read.status).toBe("read");
      if (read.status === "read")
        expect(new TextDecoder().decode(read.representation.bytes)).toBe(text);
    } finally {
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
