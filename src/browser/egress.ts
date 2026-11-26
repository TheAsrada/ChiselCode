import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
  validateHeaderValue,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function headers(values: IncomingHttpHeaders) {
  const copy = { ...values };
  for (const key of [
    ...hopHeaders,
    ...(copy.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((key) => key.trim()),
  ])
    delete copy[key];
  return copy;
}

function socketFailure(socket: Duplex, status: number) {
  socket.end(
    `HTTP/1.1 ${status} Blocked\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** Chromium cannot reach host IP sockets directly. Only this Unix HTTP bridge
 * can dial the one approved numeric loopback address; DNS is never involved. */
export async function startEgress(
  path: string,
  origin: string,
  allowed: () => Promise<boolean>,
) {
  const target = new URL(origin);
  const address = target.hostname.replace(/^\[|\]$/g, "");
  const active = new Set<Duplex>();
  let closed = false;
  const track = (socket: Duplex) => {
    active.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => active.delete(socket));
  };
  const authorized = async (
    message: { url?: string; headers: IncomingHttpHeaders },
    webSocket: boolean,
  ) => {
    try {
      const url = new URL(message.url ?? "");
      if (
        url.protocol !== (webSocket ? "ws:" : "http:") ||
        url.host !== target.host ||
        message.headers.host !== target.host ||
        url.username ||
        url.password ||
        closed ||
        !(await allowed()) ||
        closed
      )
        return;
      return url;
    } catch {
      return;
    }
  };

  const forward = (
    incoming: { method?: string; headers: IncomingHttpHeaders },
    url: URL,
    upgrades: boolean,
  ) => {
    const outgoing = request({
      hostname: address,
      port: Number(target.port),
      path: url.pathname + url.search,
      method: incoming.method,
      headers: {
        ...headers(incoming.headers),
        host: target.host,
        ...(upgrades ? { connection: "Upgrade", upgrade: "websocket" } : {}),
      },
      agent: false,
      timeout: 20_000,
    });
    outgoing.on("socket", (socket: Socket) => {
      track(socket);
      socket.once("connect", () => {
        if (
          socket.remoteAddress !== address ||
          socket.remotePort !== Number(target.port)
        )
          socket.destroy();
      });
    });
    outgoing.on("timeout", () => outgoing.destroy());
    return outgoing;
  };

  const serve = async (incoming: IncomingMessage, response: ServerResponse) => {
    const url = await authorized(incoming, false);
    if (!url) {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    if (response.destroyed) return;
    const outgoing = forward(incoming, url, false);
    response.once("close", () => outgoing.destroy());
    outgoing.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    outgoing.on("response", (upstream) => {
      const responseHeaders = headers(upstream.headers);
      // Disallow alternative transports and host-triggered downloads.
      delete responseHeaders["alt-svc"];
      delete responseHeaders["content-disposition"];
      response.writeHead(upstream.statusCode ?? 502, responseHeaders);
      upstream.on("error", () => response.destroy());
      upstream.pipe(response);
    });
    incoming.pipe(outgoing);
  };

  const server = createServer(
    {
      headersTimeout: 10_000,
      requestTimeout: 25_000,
      keepAliveTimeout: 3_000,
      maxHeaderSize: 24 * 1024,
    },
    (incoming, response) => {
      void serve(incoming, response).catch(() => response.destroy());
    },
  );
  server.maxConnections = 32;
  server.on("connection", track);
  const upgrade = async (
    incoming: { url?: string; method?: string; headers: IncomingHttpHeaders },
    downstream: Duplex,
    head: Buffer,
  ) => {
    const url = await authorized(incoming, true);
    if (!url || incoming.headers.upgrade?.toLowerCase() !== "websocket") {
      socketFailure(downstream, 403);
      return;
    }
    if (downstream.destroyed) return;
    const outgoing = forward(incoming, url, true);
    downstream.once("close", () => outgoing.destroy());
    outgoing.on("error", () => socketFailure(downstream, 502));
    outgoing.on("response", (response) => {
      response.resume();
      socketFailure(downstream, 502);
    });
    outgoing.on("upgrade", (response, upstream, upstreamHead) => {
      upstream.setTimeout(0);
      downstream.write(`HTTP/1.1 101 Switching Protocols\r\n`);
      for (let index = 0; index < response.rawHeaders.length; index += 2)
        downstream.write(
          `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`,
        );
      downstream.write("\r\n");
      if (head.length) upstream.write(head);
      if (upstreamHead.length) downstream.write(upstreamHead);
      downstream.once("close", () => upstream.destroy());
      upstream.once("close", () => downstream.destroy());
      upstream.pipe(downstream).pipe(upstream);
    });
    outgoing.end();
  };
  server.on("upgrade", (incoming, downstream, head) => {
    void upgrade(incoming, downstream, head).catch(() => downstream.destroy());
  });
  // Chromium uses CONNECT even for ws://. Admit only a bounded cleartext
  // WebSocket handshake for the same origin before opening an upstream socket.
  server.on("connect", (incoming, downstream, head) => {
    if (incoming.url !== target.host || incoming.headers.host !== target.host) {
      socketFailure(downstream, 403);
      return;
    }
    let pending = Buffer.alloc(0);
    const timeout = setTimeout(() => downstream.destroy(), 5_000);
    downstream.once("close", () => clearTimeout(timeout));
    const receive = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const boundary = pending.indexOf("\r\n\r\n");
      if (pending.length > 24 * 1024) {
        downstream.destroy();
        return;
      }
      if (boundary < 0) return;
      downstream.pause();
      downstream.removeListener("data", receive);
      clearTimeout(timeout);
      const [line, ...fields] = pending
        .subarray(0, boundary)
        .toString("latin1")
        .split("\r\n");
      const path = /^GET (\/[^\s]*) HTTP\/1\.1$/.exec(line ?? "")?.[1];
      const values: IncomingHttpHeaders = Object.create(null);
      for (const field of fields) {
        const match = /^([a-z0-9-]+):[ \t]*(.*)$/i.exec(field);
        if (
          !match?.[1] ||
          match[2] === undefined ||
          values[match[1].toLowerCase()] !== undefined
        ) {
          socketFailure(downstream, 403);
          return;
        }
        try {
          validateHeaderValue(match[1], match[2]);
        } catch {
          socketFailure(downstream, 403);
          return;
        }
        values[match[1].toLowerCase()] = match[2];
      }
      if (
        !path ||
        values["content-length"] ||
        values["transfer-encoding"] ||
        !values["sec-websocket-key"]
      ) {
        socketFailure(downstream, 403);
        return;
      }
      void upgrade(
        { url: `ws://${target.host}${path}`, method: "GET", headers: values },
        downstream,
        pending.subarray(boundary + 4),
      ).catch(() => downstream.destroy());
    };
    downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    downstream.on("data", receive);
    if (head.length) receive(head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  let closing: Promise<void> | undefined;
  return {
    close() {
      if (closing) return closing;
      closed = true;
      server.closeAllConnections();
      for (const socket of active) socket.destroy();
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve(),
        );
      });
      return closing;
    },
  };
}
