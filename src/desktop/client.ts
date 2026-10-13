import {
  DESKTOP_PROTOCOL,
  type EngineEvent,
  type Method,
  type RequestMap,
  type RpcRequest,
  type WireMessage,
} from "./protocol.js";

export * from "./protocol.js";
export interface DesktopTransport {
  send(request: RpcRequest): void;
  subscribe(listener: (message: WireMessage) => void): () => void;
}
/** A typed client; the transport owns process lifetime and framing. No retries of mutations. */
export class DesktopClient {
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: EngineEvent["params"]) => void>();
  private unsubscribe: () => void;
  private closed = false;
  constructor(private readonly transport: DesktopTransport) {
    this.unsubscribe = transport.subscribe((message) => {
      if ("method" in message) {
        for (const listener of this.listeners) listener(message.params);
        return;
      }
      if (message.id === null) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if ("error" in message)
        waiter.reject(
          Object.assign(new Error(message.error.message), {
            reason: message.error.data?.reason,
          }),
        );
      else waiter.resolve(message.result);
    });
  }
  request<M extends Method>(
    method: M,
    params: RequestMap[M]["params"],
    timeoutMs = 30_000,
  ): Promise<RequestMap[M]["result"]> {
    if (this.closed)
      return Promise.reject(new Error("Соединение с ядром закрыто."));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Ядро не ответило вовремя. Обновите состояние перед повтором действия.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as RequestMap[M]["result"]),
        reject,
        timer,
      });
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  initialize(clientVersion: string) {
    return this.request("initialize", {
      protocolMajor: DESKTOP_PROTOCOL.major,
      clientVersion,
    });
  }
  onEvent(listener: (event: EngineEvent["params"]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(reason = "Соединение с ядром закрыто."): void {
    this.closed = true;
    this.unsubscribe();
    this.listeners.clear();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
