import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../../src/context/tokenizer.js";
import {
  ToolResultStore,
  UNTRUSTED_REFERENCE,
} from "../../src/context/tool-result-store.js";
import { normalizeResult } from "../../src/tools/result.js";

test("offloaded previews preserve UTF-8 boundaries, reference trust and the complete artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-result-unicode-"));
  const store = new ToolResultStore(root);
  try {
    for (const character of ["Я", "€", "🧪"]) {
      const output =
        UNTRUSTED_REFERENCE +
        "x".repeat(3999 - Buffer.byteLength(UNTRUSTED_REFERENCE)) +
        character +
        "Полный текст 🧪\n".repeat(500);
      const result = await normalizeResult(
        { output, contentTrust: "untrusted_external" },
        store,
        1500,
      );
      const preview = result.output.split("\nOutput offloaded.")[0] ?? "";
      expect(preview).not.toContain("\uFFFD");
      expect(Buffer.from(preview).toString("utf8")).toBe(preview);
      expect(output.startsWith(preview)).toBe(true);
      expect(result.output.startsWith(UNTRUSTED_REFERENCE)).toBe(true);
      expect(estimateTokens(result.output)).toBeLessThanOrEqual(1500);
      expect(result.artifact).toBeDefined();
      expect(await store.read(result.artifact?.uri ?? "", 0, 2000)).toBe(
        UNTRUSTED_REFERENCE + output,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offloaded failure reasons keep complete graphemes and preserve the error and raw traceback", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-failure-unicode-"));
  const store = new ToolResultStore(root);
  try {
    const reason = "Error: " + "x".repeat(392) + "🧪 подробности";
    const rawOutput = reason + "\n" + "trace\n".repeat(2000);
    const result = await normalizeResult(
      {
        output: "Command failed",
        rawOutput,
        isError: true,
        errorCode: "WEB_HTTP_ERROR",
      },
      store,
      1500,
    );
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("WEB_HTTP_ERROR");
    expect(result.details?.failureReason).toBe("Error: " + "x".repeat(392));
    expect(await store.read(result.artifact?.uri ?? "", 0, 1)).toBe(reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
