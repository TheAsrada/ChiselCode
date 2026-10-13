import { expect, test } from "bun:test";
import { execa } from "execa";
import {
  ownedGroupGone,
  waitForOwnedGroupExit,
} from "../../src/processes/group-cleanup.js";

test.skipIf(process.platform === "win32")(
  "cleanup waits for a real live owned group and finishes only after its actual exit",
  async () => {
    const child = execa(
      process.execPath,
      ["-e", "console.log('READY');setInterval(()=>{},1000)"],
      { detached: true, reject: false, stdin: "ignore" },
    );
    let ready!: () => void;
    const barrier = new Promise<void>((done) => {
      ready = done;
    });
    child.stdout?.on("data", (bytes) => {
      if (bytes.toString().includes("READY")) ready();
    });
    let observed!: () => void;
    const sampled = new Promise<void>((done) => {
      observed = done;
    });
    let finished = false,
      aliveSamples = 0;
    try {
      await barrier;
      const waiting = waitForOwnedGroupExit(
        child.pid!,
        Date.now() + 8000,
        async (group, deadline) => {
          const gone = await ownedGroupGone(group, deadline);
          if (!gone) {
            aliveSamples++;
            observed();
          }
          return gone;
        },
      ).then((result) => {
        finished = true;
        return result;
      });
      await sampled;
      expect(finished).toBe(false);
      process.kill(-child.pid!, "SIGKILL");
      await child;
      expect(await waiting).toBe(true);
      expect(aliveSamples).toBeGreaterThan(0);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      await child;
    }
  },
);

test("missing or incomplete cleanup proof never becomes success and remains bounded", async () => {
  expect(
    await waitForOwnedGroupExit(1, Date.now() + 20, async () => {
      throw new Error("ps unavailable");
    }),
  ).toBe(false);
  expect(
    await waitForOwnedGroupExit(1, Date.now() + 40, async () => false),
  ).toBe(false);
});
