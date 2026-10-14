import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DesktopClient,
  type EngineEvent,
  type WireMessage,
} from "../../src/desktop/client.js";

/** Real protocol → provider driver → tools → approvals → durable history, including another process. */
export async function smokeDesktopEngine(command: string, args: string[] = []) {
  const executable =
    command.includes("/") || command.includes("\\")
      ? resolve(command)
      : command;
  const root = await mkdtemp(join(tmpdir(), "chisel-desktop-smoke-"));
  await mkdir(join(root, "config", "chiselcode"), { recursive: true });
  const config = join(root, "config", "chiselcode", "config.json");
  await writeFile(
    config,
    JSON.stringify({ schemaVersion: 2, profiles: {}, web: { enabled: false } }),
  );
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "desktop-fixture",
              context_window: 65536,
              max_output_tokens: 2048,
            },
          ],
        });
      const body = (await request.json()) as {
        messages: { role: string; content?: string }[];
        tools?: { function: { name: string } }[];
      };
      const user =
        [...body.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "user" && typeof message.content === "string",
          )?.content ?? "";
      const toolName = body.tools?.find(
        (item) => item.function.name === "write_file",
      )?.function.name;
      const edit =
        user.includes("WRITE") && body.messages.at(-1)?.role !== "tool";
      const filename = user.includes("DENY")
        ? "denied.txt"
        : user.includes("CANCEL")
          ? "cancelled.txt"
          : "desktop.txt";
      const delta = edit
        ? {
            tool_calls: [
              {
                index: 0,
                id: "desktop-write",
                type: "function",
                function: {
                  name: toolName,
                  arguments: JSON.stringify({
                    path: filename,
                    content: "ChiselCode Desktop ✓\n",
                  }),
                },
              },
            ],
          }
        : {
            content:
              "## Готово\n\nПотоковый ответ и история работают.\n\n```ts\nconst desktop = true\n```",
          };
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "desktop-fixture", choices: [{ index: 0, delta, finish_reason: edit ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  function connect() {
    const process = spawn(executable, [...args, "--config", config], {
      cwd: root,
      env: {
        ...globalThis.process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        APPDATA: join(root, "config"),
        LOCALAPPDATA: join(root, "data"),
      },
      stdio: "pipe",
    });
    const listeners = new Set<(message: WireMessage) => void>();
    const events: EngineEvent["params"][] = [];
    let raw = "";
    let buffer = "";
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const message = JSON.parse(line) as WireMessage;
        for (const listener of listeners) listener(message);
      }
    });
    process.stderr.resume();
    const client = new DesktopClient({
      send: (request) => {
        process.stdin.write(`${JSON.stringify(request)}\n`);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    process.once("error", () =>
      client.dispose("Не удалось запустить выбранный engine для smoke."),
    );
    client.onEvent((event) => events.push(event));
    async function wait(type: string, sessionId: string) {
      const since = Date.now();
      while (Date.now() - since < 15_000) {
        const event = events.find(
          (item) => item.type === type && item.sessionId === sessionId,
        );
        if (event) return event;
        await Bun.sleep(10);
      }
      throw new Error(`Desktop event timed out: ${type}`);
    }
    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      try {
        await client.request("shutdown", {}, 10_000);
      } finally {
        process.stdin.end();
        client.dispose();
        if (process.exitCode === null)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              process.kill();
              resolve();
            }, 2000);
            process.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
      }
    }
    return { client, events, wait, close, raw: () => raw };
  }
  const first = connect();
  let second: ReturnType<typeof connect> | undefined;
  try {
    await first.client.initialize("fixture");
    let rejected = false;
    try {
      await first.client.request("initialize", {
        protocolMajor: 999,
        clientVersion: "fixture",
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Incompatible protocol was accepted.");
    await first.client.request("profiles/save", {
      id: "fixture",
      providerId: "openai-compatible",
      model: "desktop-fixture",
      apiKey: "desktop-fixture-secret",
      baseUrl: `http://127.0.0.1:${model.port}/v1`,
    });
    const profiles = await first.client.request("profiles/list", {});
    if (
      !profiles.profiles[0]?.hasKey ||
      JSON.stringify(profiles).includes("desktop-fixture-secret")
    )
      throw new Error("Credential availability/redaction failed.");
    await first.client.request("projects/open", { path: root });
    const start = async (prompt: string) => {
      const session = await first.client.request("sessions/create", {
        path: root,
        profileId: "fixture",
      });
      await first.client.request("turn/start", {
        path: root,
        sessionId: session.id,
        profileId: "fixture",
        prompt,
        mode: "build",
        approvalMode: "default",
      });
      return session;
    };
    const plain = await start("Привет");
    await first.wait("turn.completed", plain.id);
    const history = await first.client.request("sessions/read", {
      path: root,
      sessionId: plain.id,
    });
    if (
      !history.messages.some((message) =>
        message.text.includes("Потоковый ответ"),
      )
    )
      throw new Error("Durable text history missing.");
    const command = await start("/lsp-status");
    await first.wait("turn.completed", command.id);
    const commandHistory = await first.client.request("sessions/read", {
      path: root,
      sessionId: command.id,
    });
    if (
      !commandHistory.messages.some(
        (message) =>
          message.role === "command" && message.text.includes("/lsp-status"),
      )
    )
      throw new Error(
        "Foreground command output disappeared after completion.",
      );
    const edit = await start("WRITE");
    const approval = await first.wait("approval.requested", edit.id);
    const data = approval.data as Record<string, unknown>;
    if (!Array.isArray(data.diffs) || !data.diffs.length)
      throw new Error("Edit approval lost the real diff.");
    let before = false;
    try {
      await readFile(join(root, "desktop.txt"));
      before = true;
    } catch {}
    if (before) throw new Error("Edit occurred before approval.");
    await first.client.request("approvals/respond", {
      requestId: data.requestId as string,
      decision: "approved",
    });
    await first.wait("turn.completed", edit.id);
    if (
      !(await readFile(join(root, "desktop.txt"), "utf8")).includes("Desktop ✓")
    )
      throw new Error("Approved edit did not execute.");
    const denied = await start("WRITE DENY");
    const denial = (await first.wait("approval.requested", denied.id))
      .data as Record<string, unknown>;
    await first.client.request("approvals/respond", {
      requestId: denial.requestId as string,
      decision: "denied",
    });
    await first.wait("turn.completed", denied.id);
    let forbidden = false;
    try {
      await readFile(join(root, "denied.txt"));
      forbidden = true;
    } catch {}
    if (forbidden) throw new Error("Denied edit occurred.");
    const cancelled = await start("WRITE CANCEL");
    await first.wait("approval.requested", cancelled.id);
    second = connect();
    await second.client.initialize("fixture");
    const other = await second.client.request("sessions/create", {
      path: root,
      profileId: "fixture",
    });
    await second.client.request("turn/start", {
      path: root,
      sessionId: other.id,
      profileId: "fixture",
      prompt: "Привет",
      mode: "build",
      approvalMode: "default",
    });
    const blocked = (await second.wait("turn.completed", other.id))
      .data as Record<string, unknown>;
    if (!String(blocked.error).includes("другом процессе"))
      throw new Error("Cross-process workspace admission failed.");
    await first.client.request("turn/cancel", { sessionId: cancelled.id });
    await first.wait("turn.completed", cancelled.id);
    const backgroundSession = await start(
      "/tasks start node -e \"console.log('desktop-background-ready');setTimeout(()=>{},30000)\"",
    );
    const backgroundApproval = (
      await first.wait("approval.requested", backgroundSession.id)
    ).data as Record<string, unknown>;
    await first.client.request("approvals/respond", {
      requestId: backgroundApproval.requestId as string,
      decision: "approved",
    });
    await first.wait("turn.completed", backgroundSession.id);
    const listed = (await first.client.request("tasks/list", {
      path: root,
      sessionId: backgroundSession.id,
    })) as { background: Record<string, { id: string }> };
    const task = Object.values(listed.background)[0];
    if (!task) throw new Error("Live background process was not exposed.");
    let inspected = "";
    for (let retry = 0; retry < 100; retry++) {
      inspected = (
        await first.client.request("tasks/inspect", {
          sessionId: backgroundSession.id,
          id: task.id,
          view: "history",
        })
      ).text;
      if (inspected.includes("desktop-background-ready")) break;
      await Bun.sleep(50);
    }
    if (!inspected.includes("desktop-background-ready"))
      throw new Error(
        `Live background output was unavailable: ${inspected} ${JSON.stringify(listed)}`,
      );
    if (!(await first.client.request("system/status", {})).busy)
      throw new Error("Background activity did not block updates.");
    await first.client.request("tasks/cancel", {
      sessionId: backgroundSession.id,
      id: task.id,
    });
    const stopped = (await first.client.request("tasks/list", {
      path: root,
      sessionId: backgroundSession.id,
    })) as {
      background: Record<
        string,
        { state: string; cleanup: { confirmed: boolean } }
      >;
    };
    if (!stopped.background[task.id]?.cleanup.confirmed)
      throw new Error(
        "Targeted background stop did not confirm process cleanup.",
      );
    if (first.raw().includes("desktop-fixture-secret"))
      throw new Error("Secret leaked to the wire.");
    await first.close();
    const resumed = await second.client.request("sessions/read", {
      path: root,
      sessionId: plain.id,
    });
    if (
      !resumed.messages.some((message) =>
        message.text.includes("Потоковый ответ"),
      )
    )
      throw new Error("History did not survive engine restart.");
    console.log(
      "Desktop protocol, credentials, streaming, approvals, denial, cancellation, process admission and durable resume verified.",
    );
  } finally {
    await first.close().catch(() => {});
    await second?.close().catch(() => {});
    model.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
if (import.meta.main)
  await smokeDesktopEngine(
    process.argv[2] ?? process.execPath,
    process.argv.length > 2
      ? process.argv.slice(3)
      : [join(import.meta.dir, "../../src/desktop/entry.ts")],
  );
