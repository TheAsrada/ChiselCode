import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GlobalConfigV2Schema } from "../../src/config/schema.js";
import { CustomProviderManifestV1Schema } from "../../src/providers/custom/schema.js";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";

test("architecture: SDK imports only in drivers; generic layers have no provider literal dispatch", async () => {
  const sdkFiles: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan(".")) {
    const source = await readFile(file, "utf8");
    if (/from ["'](?:openai|@anthropic-ai\/sdk)(?:\/[^"']*)?["']/.test(source))
      sdkFiles.push(file);
    if (!file.startsWith("src/providers/"))
      expect(source).not.toMatch(
        /(?:provider(?:Id)?|kind)\s*[!=]==?\s*["'](?:anthropic(?:-compatible)?|openai(?:-compatible)?|agentrouter)["']/,
      );
    if (file !== "src/types/domain.ts")
      expect(source).not.toContain("ProviderKind");
  }
  expect(sdkFiles.sort()).toEqual([
    "src/providers/drivers/anthropic-messages.ts",
    "src/providers/drivers/openai-chat.ts",
  ]);
  const runtime = await readFile("src/runtime/agent-runtime.ts", "utf8");
  expect(runtime).not.toMatch(
    /ProviderRegistry|ProviderDefinition|DriverRegistry|ProviderProfile/,
  );
});
test("documentation examples parse actual schemas and metadata remains consistent", async () => {
  const providers = await readFile("docs/providers.md", "utf8");
  for (const d of builtinDefinitions) {
    const row = providers
      .split("\n")
      .find((line) => line.startsWith(`| \`${d.id}\` |`));
    expect(row).toBeDefined();
    expect(row).toContain(d.label);
    expect(row).toContain(d.driverId);
    for (const env of d.auth.envVars) expect(row).toContain(env);
    if (d.defaults.model) expect(row).toContain(d.defaults.model);
    if (d.endpoint.defaultBaseUrl)
      expect(row).toContain(d.endpoint.defaultBaseUrl);
  }
  for (const name of ["custom-providers", "configuration"]) {
    const text = await readFile(`docs/${name}.md`, "utf8");
    for (const block of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const value = JSON.parse(block[1] ?? "{}");
      if (value.schemaVersion === 1 && value.driver)
        expect(CustomProviderManifestV1Schema.safeParse(value).success).toBe(
          true,
        );
      if (value.schemaVersion === 2)
        expect(GlobalConfigV2Schema.safeParse(value).success).toBe(true);
    }
  }
});
test("acceptance: custom manifest plus profile runs CLI through generic driver without rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-custom-acceptance-"));
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe(
        "Bearer fake-acceptance-key",
      );
      const body = (await request.json()) as {
        model: string;
        max_completion_tokens?: number;
      };
      expect(body.model).toBe("coder");
      calls++;
      const chunks = [
        {
          id: "answer",
          choices: [
            {
              index: 0,
              delta: { content: "Gateway works" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "answer",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const data = join(
      root,
      process.platform === "win32" ? "ChiselCode" : "chiselcode",
    );
    await mkdir(join(data, "providers", "my-gateway"), { recursive: true });
    await writeFile(
      join(data, "providers", "my-gateway", "provider.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "myorg/gateway",
        label: "My Gateway",
        driver: "openai-chat",
        auth: { required: true, envVars: ["MY_GATEWAY_API_KEY"] },
        endpoint: {
          required: false,
          defaultBaseUrl: `http://127.0.0.1:${server.port}/v1`,
          normalization: "openai-v1",
        },
        defaults: { model: "coder" },
        capabilities: {
          modelListing: false,
          tokenCounting: "unsupported",
          usageReporting: "unknown",
          toolCalling: true,
          thinking: false,
        },
      }),
    );
    const config = join(root, "config", "chiselcode");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "gateway-work",
        profiles: { "gateway-work": { providerId: "myorg/gateway" } },
      }),
    );
    const env = {
      ...process.env,
      XDG_DATA_HOME: root,
      LOCALAPPDATA: root,
      XDG_CONFIG_HOME: join(root, "config"),
      APPDATA: join(root, "config"),
      MY_GATEWAY_API_KEY: "fake-acceptance-key",
    };
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "--cwd",
        root,
        "--profile",
        "gateway-work",
        "--json",
        "Say hello",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).not.toContain("API-ключ");
    expect(code).toBe(0);
    const result = JSON.parse(output);
    expect(result.text).toBe("Gateway works");
    expect(result.costEstimate.source).toBe("unknown");
    expect(result.totalCost).toBeUndefined();
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
