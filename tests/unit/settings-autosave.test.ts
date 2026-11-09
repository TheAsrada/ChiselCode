import { expect, test } from "bun:test";
import { SettingsAutosave } from "../../src/ui/settings-autosave.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("autosave coalesces typing, drains the newest value and shares the close barrier", async () => {
  const writes: string[] = [];
  const first = deferred();
  const queue = new SettingsAutosave((error) => {
    throw error;
  });
  queue.schedule(
    "a",
    async () => {
      writes.push("a");
      await first.promise;
    },
    10000,
  );
  const closing = queue.flush();
  queue.schedule(
    "ab",
    async () => {
      writes.push("ab");
    },
    10000,
  );
  queue.schedule(
    "abc",
    async () => {
      writes.push("abc");
    },
    10000,
  );
  expect(queue.flush()).toBe(closing);
  first.resolve();
  expect(await closing).toBe(true);
  expect(writes).toEqual(["a", "abc"]);
  queue.dispose();
});
test("reverting to the old baseline while a write is pending persists the last choice", async () => {
  const writes: boolean[] = [];
  const first = deferred();
  const queue = new SettingsAutosave((error) => {
    throw error;
  });
  queue.schedule(
    "true",
    async () => {
      writes.push(true);
    },
    0,
    false,
  );
  queue.schedule(
    "false",
    async () => {
      writes.push(false);
      await first.promise;
    },
    10000,
  );
  const pending = queue.flush();
  queue.schedule(
    "true",
    async () => {
      writes.push(true);
    },
    10000,
    false,
  );
  first.resolve();
  expect(await pending).toBe(true);
  expect(writes).toEqual([false, true]);
  queue.dispose();
});
test("a failed write retains its operation for an explicit retry; clean loads never write", async () => {
  const errors: unknown[] = [];
  let fail = true;
  let writes = 0;
  const queue = new SettingsAutosave((error) => errors.push(error));
  queue.schedule(
    "loaded",
    async () => {
      writes++;
    },
    0,
    false,
  );
  expect(await queue.flush()).toBe(true);
  expect(writes).toBe(0);
  queue.schedule(
    "edit",
    async () => {
      writes++;
      if (fail) throw new Error("disk full");
    },
    10000,
  );
  expect(await queue.flush()).toBe(false);
  expect(String(errors[0])).toContain("disk full");
  expect(writes).toBe(1);
  fail = false;
  expect(await queue.flush()).toBe(true);
  expect(writes).toBe(2);
  queue.dispose();
});
