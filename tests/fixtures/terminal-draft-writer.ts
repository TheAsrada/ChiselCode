import assert from "node:assert/strict";
import {
  loadTerminalDraft,
  saveTerminalDraft,
} from "../../src/ui/terminal-drafts.js";

const identity = { applicationId: process.argv[2]! };
assert.equal(await loadTerminalDraft(identity), "initial");
console.log("ready");
await Bun.stdin.text();
await assert.rejects(
  saveTerminalDraft(identity, undefined, "stale writer text"),
  /Оба текста сохранены отдельно/,
);
console.log("conflict preserved");
