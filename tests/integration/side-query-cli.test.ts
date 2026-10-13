import { expect, test } from "bun:test";

// Each protocol owns seven genuine CLI launches and real retry delays. Keep
// their deadlines separate rather than timing fourteen startups as one case.
for (const protocol of ["oa", "anth"])
  test(`ordinary CLI /btw ${protocol} uses its real protocol driver and bounded actual HTTP retries`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "tests/fixtures/side-query-cli.ts",
        process.execPath,
        "src/cli.ts",
      ],
      {
        env: { ...process.env, CHISEL_TEST_SIDE_QUERY_PROTOCOL: protocol },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const errors = (async () => {
      const decoder = new TextDecoder();
      let captured = "";
      let pending = "";
      for await (const chunk of child.stderr) {
        const text = decoder.decode(chunk, { stream: true });
        captured += text;
        pending += text;
        let end = pending.indexOf("\n");
        while (end !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line.startsWith("Side query CLI:"))
            process.stderr.write(`[${protocol}] ${line}\n`);
          end = pending.indexOf("\n");
        }
      }
      return captured + decoder.decode();
    })();
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      errors,
      child.exited,
    ]);
    expect(error).not.toContain("AssertionError");
    expect(code).toBe(0);
    expect(output).toContain("Side query CLI:");
  }, 30000);
