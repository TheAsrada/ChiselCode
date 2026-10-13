import type { RpcResponse, WireMessage } from "./protocol.js";
import { DesktopError, DesktopServer } from "./server.js";

const MAX_FRAME = 16 * 1024 * 1024;
/** Dedicated stdio only: no network listener, stdout contains framed protocol exclusively. */
export async function serveDesktopStdio(configPath?: string): Promise<void> {
  console.log = console.info = (...items: unknown[]) => console.error(...items);
  let output = Promise.resolve();
  const send = (message: WireMessage) => {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME)
      throw new DesktopError(
        "PAYLOAD_TOO_LARGE",
        "Ответ слишком большой для интерфейса.",
      );
    const next = output.then(
      () =>
        new Promise<void>((resolve, reject) =>
          process.stdout.write(line, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
    );
    output = next.catch(() => {});
    return next;
  };
  const server = new DesktopServer(send, configPath);
  let buffer = "";
  let stopping = false;
  const pending = new Set<Promise<void>>();
  const handle = async (line: string) => {
    let id: number | null = null;
    let shutdown = false;
    try {
      const message = JSON.parse(line) as {
        jsonrpc: unknown;
        id: unknown;
        method: unknown;
        params: unknown;
      };
      if (
        message.jsonrpc !== "2.0" ||
        !Number.isSafeInteger(message.id) ||
        typeof message.method !== "string"
      )
        throw new DesktopError(
          "INVALID_REQUEST",
          "Некорректное сообщение протокола.",
        );
      id = message.id as number;
      const result = await server.dispatch(
        message.method,
        message.params ?? {},
      );
      await send({ jsonrpc: "2.0", id, result });
      shutdown = message.method === "shutdown";
    } catch (error) {
      const reason =
        error instanceof DesktopError ? error.reason : "ENGINE_ERROR";
      const response: RpcResponse = {
        jsonrpc: "2.0",
        id,
        error: {
          code:
            reason === "METHOD_NOT_FOUND"
              ? -32601
              : reason === "INVALID_PARAMS"
                ? -32602
                : -32000,
          message: server.sanitizeError(error),
          data: { reason },
        },
      };
      await send(response);
    }
    if (shutdown) {
      stopping = true;
      process.stdin.pause();
      process.exitCode = 0;
    }
  };
  await new Promise<void>((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (stopping) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        stopping = true;
        reject(new Error("Превышен лимит сообщения протокола."));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        if (pending.size > 128) {
          stopping = true;
          reject(new Error("Слишком много запросов к ядру."));
          return;
        }
        const work = handle(line).catch(reject);
        pending.add(work);
        void work.finally(() => {
          pending.delete(work);
          if (stopping) resolve();
        });
      }
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", reject);
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await server.dispose();
  await Promise.allSettled(pending);
  await output;
}
