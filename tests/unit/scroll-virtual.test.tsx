import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Box, render, Text } from "ink";
import { useEffect } from "react";
import { emptyScrollMetrics, ScrollViewport } from "../../src/ui/scroll.js";

test("long history mounts only visible messages and preserves the reading anchor on reflow", async () => {
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY: true,
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {
      return this;
    },
    unref() {
      return this;
    },
  });
  stdout.resume();
  const mounted = new Set<number>();
  function Message({ id, height }: { id: number; height: number }) {
    useEffect(() => {
      mounted.add(id);
      return () => {
        mounted.delete(id);
      };
    }, [id]);
    return (
      <Box height={height}>
        <Text>{`message ${id}`}</Text>
      </Box>
    );
  }
  const metrics = { current: emptyScrollMetrics() };
  const items = (height: number) =>
    Array.from({ length: 5000 }, (_, id) => ({
      id,
      height,
      content: <Message id={id} height={height} />,
    }));
  const view = (height: number, top: number | null) => (
    <Box width={80} height={20}>
      <ScrollViewport
        items={items(height)}
        top={top}
        metrics={metrics}
        layoutKey={height}
      />
    </Box>
  );
  const instance = render(view(1, null), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  try {
    await tick();
    expect(mounted.size).toBeLessThan(30);
    expect(mounted.has(4999)).toBe(true);
    expect(metrics.current.maxTop).toBe(4980);
    instance.rerender(view(1, 2500));
    await tick();
    expect(mounted.has(2500)).toBe(true);
    expect(mounted.has(4999)).toBe(false);
    instance.rerender(view(2, 2500));
    await tick();
    expect(metrics.current.top).toBe(5000);
    expect(mounted.has(2500)).toBe(true);
    expect(mounted.size).toBeLessThan(20);
    instance.rerender(view(2, null));
    await tick();
    expect(mounted.has(4999)).toBe(true);
  } finally {
    instance.unmount();
  }
});
