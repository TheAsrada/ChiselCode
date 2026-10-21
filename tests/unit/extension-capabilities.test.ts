import { expect, test } from "bun:test";
import { SDK_CAPABILITIES } from "../../src/extension-sdk/capabilities.js";
import {
  compatibility,
  ExtensionManifestSchema,
} from "../../src/extensions/external/manifest.js";
import { sanitizeUi } from "../../src/extensions/ui.js";
import { UiSnapshotSchema, uiNodeInfo } from "../../src/extensions/ui-types.js";
import { SecretRedactor } from "../../src/security/redaction.js";

const base = {
  schemaVersion: 1,
  apiVersion: 1,
  id: "example.capabilities",
  version: "1.0.0",
  entry: "index.mjs",
  displayName: "Проверка",
};
test("additive features are immutable and required capabilities are checked without loading code", () => {
  expect(Object.isFrozen(SDK_CAPABILITIES)).toBe(true);
  expect(compatibility(ExtensionManifestSchema.parse(base))).toBeUndefined();
  expect(
    compatibility(
      ExtensionManifestSchema.parse({
        ...base,
        requires: ["ui.controls", "agent.events"],
      }),
    ),
  ).toBeUndefined();
  expect(
    compatibility(
      ExtensionManifestSchema.parse({ ...base, requires: ["future.feature"] }),
    ),
  ).toContain("future.feature");
});
test("stable renderer keys survive redaction while opaque action arguments still mask credentials", () => {
  const redactor = new SecretRedactor();
  redactor.add("actual-private-value");
  const snapshot = sanitizeUi(
    UiSnapshotSchema,
    {
      revision: 1,
      state: "ready",
      render: {
        mode: "replace",
        content: {
          type: "box",
          key: "container",
          children: [
            {
              type: "input",
              key: "note",
              label: "Текст",
              value: "actual-private-value",
              onSubmit: {
                id: "submit",
                args: { apiKey: "private", key: "opaque-secret" },
              },
            },
            { type: "text", key: "label", text: "actual-private-value" },
            {
              type: "box",
              children: [
                {
                  type: "text",
                  key: "label",
                  text: "Повтор sibling-local key",
                },
              ],
            },
          ],
        },
      },
    },
    redactor,
  );
  expect(snapshot.render?.content?.key).toBe("container");
  const info = uiNodeInfo(snapshot.render?.content);
  expect(info.events[0]?.node.key).toBe("note");
  expect(info.events[0]?.use.args).toEqual({
    apiKey: "[секрет скрыт]",
    key: "[секрет скрыт]",
  });
  expect(JSON.stringify(snapshot)).not.toContain("actual-private-value");
  expect(() =>
    uiNodeInfo({
      type: "box",
      children: [
        { type: "input", key: "same", label: "A", value: "" },
        {
          type: "box",
          children: [{ type: "input", key: "same", label: "B", value: "" }],
        },
      ],
    }),
  ).toThrow("Duplicate UI input key");
});
