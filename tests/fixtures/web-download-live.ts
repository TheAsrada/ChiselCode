/** Explicit live check: real public Web and OS Desktop, scripted local model, no paid model call. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrompt } from "../../src/app/run-prompt.js";

const temporary = await mkdtemp(join(tmpdir(), "chisel-live-download-"));
const root = join(temporary, "project");
await mkdir(root);
for (const key of ["XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"])
  process.env[key] = join(temporary, "state");
process.env.OPENAI_API_KEY = "fixture-native-web-local-model";
let childSteps = 0,
  parentSteps = 0,
  childId = "",
  imageUrl = "";
const filename = `ChiselCode-network-check-${Date.now()}.png`;
type Body = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
};
const textResponse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
const toolResponse = (name: string, input: unknown, id: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-model",
            context_window: 131072,
            max_output_tokens: 8192,
          },
        ],
      });
    const body = (await request.json()) as Body;
    if (
      String(body.messages[0]?.content).includes(
        "Поручение выполняется отдельным помощником.",
      )
    ) {
      childSteps++;
      if (childSteps === 1)
        return toolResponse(
          "web_search",
          {
            query: "Python official logo PNG python.org/community/logos",
            limit: 3,
          },
          "find-logo",
        );
      if (childSteps === 2)
        return toolResponse(
          "web_fetch",
          { url: "https://www.python.org/community/logos/", maxChars: 50000 },
          "open-official-logo",
        );
      const page = String(
        body.messages.filter((message) => message.role === "tool").at(-1)
          ?.content,
      );
      const match = /https:\/\/(?:www\.)?python\.org\/[^\s)"<>]*\.png/i.exec(
        page,
      );
      if (!match)
        return textResponse(`IMAGE_NOT_FOUND: ${page.slice(0, 1500)}`);
      return textResponse(
        `IMAGE_URL=${match[0]}\nSOURCE=https://www.python.org/community/logos/\nИзображение найдено на официальной странице. Файл не скачивался помощником.`,
      );
    }
    parentSteps++;
    const toolName = (part: string) =>
      body.tools?.find((tool) => tool.function.name.includes(part))?.function
        .name ?? part;
    if (parentSteps === 1)
      return toolResponse(
        toolName("submit_readonly"),
        {
          task: "Найди прямой PNG URL официального логотипа Python на python.org. Только поиск и чтение; ничего не скачивай и не изменяй.",
          label: "Найти изображение",
          context: "none",
        },
        "delegate-image",
      );
    for (const message of body.messages.filter(
      (item) => item.role === "tool",
    )) {
      try {
        const value = JSON.parse(String(message.content));
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item.id && item.label === "Найти изображение") childId = item.id;
          const match = /IMAGE_URL=(https:\/\/[^\s]+)/.exec(item.text ?? "");
          if (match) imageUrl = match[1]!;
        }
      } catch {
        /* Tool framing is not execution authority. */
      }
    }
    if (!imageUrl) {
      assert.ok(childId, "No accepted child ID");
      if (parentSteps > 5)
        throw new Error(
          "The child did not find an image: " +
            JSON.stringify(body.messages.at(-1)),
        );
      return toolResponse(
        toolName("subagents_wait"),
        { ids: [childId], timeoutMs: 30000 },
        `wait-image-${parentSteps}`,
      );
    }
    if (
      !body.messages.some(
        (message) =>
          message.role === "tool" && String(message.content).includes(filename),
      )
    )
      return toolResponse(
        "web_download",
        { url: imageUrl, directory: "desktop", filename },
        "save-image-on-real-desktop",
      );
    return textResponse(
      "Файл сохранён и проверен core web_download; фактический путь и SHA-256 находятся в результате инструмента.",
    );
  },
});
const configPath = join(temporary, "global.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: true },
  }),
);
try {
  const { result, exitCode } = await runPrompt(
    "Поручи помощнику найти изображение официального логотипа Python; сам скачай найденный PNG на настоящий рабочий стол и проверь файл.",
    {
      cwd: root,
      configPath,
      allow: "ext:builtin.subagents:submit_readonly,web_download",
      json: true,
    },
    { requestApproval: async () => "unavailable" },
    {
      onToolResult(name, result) {
        console.error(name, result.isError ? result.output : "проверено");
      },
    },
    AbortSignal.timeout(120000),
  );
  assert.equal(exitCode, 0, result.error);
  const download = Object.values(
    result.session.runtime?.invocations ?? {},
  ).find((entry) => entry.name === "web_download")?.result;
  assert.ok(download && !download.isError, "Native download did not succeed");
  const info = download.details!.web as {
    path: string;
    bytes: number;
    sha256: string;
    contentType: string;
  };
  const file = await readFile(info.path);
  assert.equal(file.length, info.bytes);
  assert.equal(file.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(createHash("sha256").update(file).digest("hex"), info.sha256);
  console.log(
    JSON.stringify(
      {
        scenario:
          "readonly child finds public image → main downloads to OS Desktop → PNG/size/SHA-256 verified",
        ...info,
      },
      null,
      2,
    ),
  );
} finally {
  server.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
