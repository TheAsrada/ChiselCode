import { describe, expect, test } from "bun:test";
import {
  createMouseFilter,
  subscribeWheel,
  type WheelDirection,
} from "../../src/ui/mouse.js";

function fakeStreams() {
  const listeners = new Map<string, Set<(chunk: unknown) => void>>();
  const stdin = {
    isTTY: true,
    encoding: "",
    rawMode: false,
    refCount: 0,
    setEncoding(encoding: string): void {
      stdin.encoding = encoding;
    },
    on(event: string, listener: (chunk: unknown) => void): void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    off(event: string, listener: (chunk: unknown) => void): void {
      listeners.get(event)?.delete(listener);
    },
    setRawMode(mode: boolean): void {
      stdin.rawMode = mode;
    },
    ref(): void {
      stdin.refCount += 1;
    },
    unref(): void {
      stdin.refCount -= 1;
    },
    emitData(chunk: unknown): void {
      for (const listener of listeners.get("data") ?? []) listener(chunk);
    },
    dataListenerCount(): number {
      return listeners.get("data")?.size ?? 0;
    },
  };
  const stdout = {
    writes: [] as string[],
    write(data: string): void {
      stdout.writes.push(data);
    },
  };
  return { stdin, stdout };
}

function drain(
  filter: NonNullable<ReturnType<typeof createMouseFilter>>,
): string {
  let out = "";
  for (;;) {
    const chunk: string | null = filter.stdin.read();
    if (chunk === null) return out;
    out += chunk;
  }
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

describe("mouse input filter", () => {
  test("wheel scrolls, clicks are swallowed, text passes through", () => {
    const { stdin, stdout } = fakeStreams();
    const wheels: WheelDirection[] = [];
    const filter = must(
      createMouseFilter({
        stdin,
        stdout,
        onWheel: (direction) => wheels.push(direction),
      }),
    );
    expect(stdout.writes).toEqual(["\x1b[?1000h\x1b[?1006h"]);
    stdin.emitData("hi\x1b[<65;1;1Mthere\x1b[<0;2;3M!");
    expect(wheels).toEqual(["down"]);
    expect(drain(filter)).toBe("hithere!");
    filter.dispose();
    expect(stdout.writes.at(-1)).toBe("\x1b[?1000l\x1b[?1006l");
    expect(stdin.dataListenerCount()).toBe(0);
  });

  test("returns undefined without a TTY", () => {
    const { stdout } = fakeStreams();
    expect(
      createMouseFilter({ stdin: { isTTY: false }, stdout }),
    ).toBeUndefined();
  });

  test("split sequences reassemble across chunks", () => {
    const { stdin, stdout } = fakeStreams();
    const wheels: WheelDirection[] = [];
    const filter = must(
      createMouseFilter({
        stdin,
        stdout,
        onWheel: (direction) => wheels.push(direction),
      }),
    );
    stdin.emitData("\x1b[<6");
    expect(wheels).toEqual([]);
    expect(drain(filter)).toBe("");
    stdin.emitData("5;1;1Mok");
    expect(wheels).toEqual(["down"]);
    expect(drain(filter)).toBe("ok");
    filter.dispose();
  });

  test("lone escape flushes through after a pause", async () => {
    const { stdin, stdout } = fakeStreams();
    const filter = must(
      createMouseFilter({ stdin, stdout, onWheel: () => {} }),
    );
    stdin.emitData("\x1b");
    // Esc придержан: вдруг это начало mouse-последовательности.
    expect(drain(filter)).toBe("");
    await Bun.sleep(80);
    expect(drain(filter)).toBe("\x1b");
    filter.dispose();
  });

  test("forwards raw mode and ref counting to the real stdin", () => {
    const { stdin, stdout } = fakeStreams();
    const filter = must(
      createMouseFilter({ stdin, stdout, onWheel: () => {} }),
    );
    filter.stdin.setRawMode(true);
    expect(stdin.rawMode).toBe(true);
    filter.stdin.ref();
    filter.stdin.unref();
    expect(stdin.refCount).toBe(0);
    filter.stdin.setRawMode(false);
    expect(stdin.rawMode).toBe(false);
    filter.dispose();
  });

  test("wheel bus notifies subscribers until unsubscribed", () => {
    const first: WheelDirection[] = [];
    const second: WheelDirection[] = [];
    const off1 = subscribeWheel((direction) => first.push(direction));
    const off2 = subscribeWheel((direction) => second.push(direction));
    const { stdin, stdout } = fakeStreams();
    // Без onWheel фильтр вещает подписчикам шины.
    const filter = must(createMouseFilter({ stdin, stdout }));
    stdin.emitData("\x1b[<64;1;1M");
    expect(first).toEqual(["up"]);
    expect(second).toEqual(["up"]);
    off1();
    off2();
    filter.dispose();
  });
});
