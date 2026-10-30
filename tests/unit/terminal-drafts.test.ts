import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { packageDirectory } from "../../src/extensions/packages/storage.js";
import { CredentialStore } from "../../src/security/credentials.js";
import {
  loadApplicationDraft,
  loadTerminalDraft,
  saveTerminalDraft,
} from "../../src/ui/terminal-drafts.js";

let root: string;
const names = ["LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
let previous: Array<string | undefined>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chisel-drafts-"));
  previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = root;
});
afterEach(async () => {
  names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
  await rm(root, { recursive: true, force: true });
});

test("application drafts have separate protected identities; a live instance is never restored over", async () => {
  const a = { applicationId: randomUUID() },
    b = { applicationId: randomUUID() };
  await saveTerminalDraft(a, undefined, "draft A");
  await saveTerminalDraft(b, undefined, "draft B");
  expect(await loadTerminalDraft(a)).toBe("draft A");
  expect(await loadTerminalDraft(b)).toBe("draft B");
  expect(await loadApplicationDraft()).toBeUndefined();
  await saveTerminalDraft(a, undefined, "closed A", { closed: true });
  expect(await loadApplicationDraft()).toBe("closed A");
  expect(await loadTerminalDraft(b)).toBe("draft B");
});

test("failed metadata publication cannot overwrite the previously published protected payload", async () => {
  const id = { applicationId: randomUUID() };
  await saveTerminalDraft(id, undefined, "previous");
  const directory = await packageDirectory(".terminal-drafts");
  const metadataPath = join(
    directory,
    (await readdir(directory)).find((name) => name.endsWith(".json"))!,
  );
  const old = JSON.parse(await readFile(metadataPath, "utf8"));
  const set = CredentialStore.prototype.set;
  const interceptor = spyOn(
    CredentialStore.prototype,
    "set",
  ).mockImplementation(async function (this: CredentialStore, name, value) {
    await set.call(this, name, value);
    await rename(metadataPath, `${metadataPath}.previous`);
    await mkdir(metadataPath);
  });
  try {
    await expect(
      saveTerminalDraft(id, undefined, "replacement"),
    ).rejects.toThrow();
  } finally {
    interceptor.mockRestore();
    await rm(metadataPath, { recursive: true });
    await rename(`${metadataPath}.previous`, metadataPath);
  }
  expect(await loadTerminalDraft(id)).toBe("previous");
  expect(await new CredentialStore().get(old.reference)).toBe("previous");
});

test("two real processes preserve both texts when a stale writer publishes", async () => {
  const identity = { applicationId: randomUUID() };
  await saveTerminalDraft(identity, undefined, "initial");
  const child = execa(
    process.execPath,
    ["tests/fixtures/terminal-draft-writer.ts", identity.applicationId],
    { stdin: "pipe", cancelSignal: AbortSignal.timeout(10_000) },
  );
  try {
    const [ready] = await once(child.stdout!, "data", {
      signal: AbortSignal.timeout(10_000),
    });
    expect(String(ready).trim()).toBe("ready");
    await saveTerminalDraft(identity, undefined, "current writer text");
    child.stdin!.end("continue\n");
    expect((await child).stdout).toContain("conflict preserved");
    expect(await loadTerminalDraft(identity)).toBe("current writer text");
    expect(await loadApplicationDraft()).toBe("stale writer text");
  } finally {
    child.kill();
    await child.catch(() => {});
  }
}, 15_000);
