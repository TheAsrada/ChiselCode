import { readFile } from "node:fs/promises";
import { createServer as httpServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { resolve } from "node:path";

export const networkTlsDirectory = resolve("tests/fixtures/network-tls");
export async function networkCertificates() {
  const [ca, cert, key] = await Promise.all([
    readFile(resolve(networkTlsDirectory, "ca.pem"), "utf8"),
    readFile(resolve(networkTlsDirectory, "identity.pem"), "utf8"),
    readFile(resolve(networkTlsDirectory, "identity-key.pem"), "utf8"),
  ]);
  return { ca, cert, key };
}
export async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}
/** Deliberately maps a validated public IP to test loopback behind an explicit test proxy. */
export async function startNetworkProxy(options: {
  destinationPort: number;
  secure?: boolean;
  requireClientCertificate?: boolean;
  auth?: string;
}) {
  const certificates = await networkCertificates();
  const sockets = new Set<Socket>();
  const requests: Array<{
    target: string;
    authorization?: string;
    peer?: string;
  }> = [];
  if (options.secure) {
    type State = { head: string; upstream?: Socket; peer?: string };
    const listener = Bun.listen<State>({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        ...certificates,
        requestCert: true,
        rejectUnauthorized: options.requireClientCertificate ?? false,
      },
      socket: {
        open(socket) {
          socket.data = { head: "" };
        },
        handshake(socket, success) {
          if (!success) {
            socket.end();
            return;
          }
          const name = socket.getPeerCertificate()?.subject?.CN;
          socket.data.peer = Array.isArray(name) ? name[0] : name;
        },
        data(downstream, chunk) {
          if (downstream.data.upstream) {
            downstream.data.upstream.write(chunk);
            return;
          }
          downstream.data.head += chunk.toString();
          const index = downstream.data.head.indexOf("\r\n\r\n");
          if (index < 0) return;
          const raw = downstream.data.head;
          const target = /^CONNECT (\S+)/.exec(raw)?.[1] ?? "";
          const authorization = /^Proxy-Authorization:\s*(.*)$/im
            .exec(raw)?.[1]
            ?.trim();
          requests.push({ target, authorization, peer: downstream.data.peer });
          if (options.auth && authorization !== options.auth) {
            downstream.end(
              "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
            );
            return;
          }
          const upstream = connect(options.destinationPort, "127.0.0.1");
          downstream.data.upstream = upstream;
          sockets.add(upstream);
          upstream.on("connect", () => {
            downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            const rest = raw.slice(index + 4);
            if (rest) upstream.write(rest);
          });
          upstream.on("data", (data) => downstream.write(data));
          upstream.on("end", () => downstream.end());
          upstream.on("close", () => {
            sockets.delete(upstream);
            downstream.end();
          });
          upstream.on("error", () => downstream.end());
        },
        close(socket) {
          socket.data.upstream?.destroy();
        },
        error(socket) {
          socket.data.upstream?.destroy();
        },
      },
    });
    return {
      port: listener.port,
      url: `https://127.0.0.1:${listener.port}`,
      requests,
      async close() {
        listener.stop(true);
        for (const socket of sockets) socket.destroy();
      },
    };
  }
  const server = httpServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, downstream, head) => {
    requests.push({
      target: request.url ?? "",
      authorization: request.headers["proxy-authorization"] as
        | string
        | undefined,
    });
    if (
      options.auth &&
      request.headers["proxy-authorization"] !== options.auth
    ) {
      downstream.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const upstream = connect(options.destinationPort, "127.0.0.1");
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("connect", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => upstream.destroy());
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Native TLS fixture verifies actual client certificates; node:https's Bun server shim hides them. */
export async function startTlsOrigin(text = "authenticated documentation") {
  const peers: Array<string | undefined> = [];
  const listener = Bun.listen<{ sent: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      ...(await networkCertificates()),
      requestCert: true,
      rejectUnauthorized: true,
    },
    socket: {
      open(socket) {
        socket.data = { sent: false };
      },
      handshake(socket, success) {
        if (!success) {
          socket.end();
          return;
        }
        const name = socket.getPeerCertificate()?.subject?.CN;
        peers.push(Array.isArray(name) ? name[0] : name);
      },
      data(socket) {
        if (socket.data.sent) return;
        socket.data.sent = true;
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
        );
      },
      error(socket) {
        socket.end();
      },
    },
  });
  return {
    port: listener.port,
    peers,
    close() {
      listener.stop(true);
    },
  };
}

export async function withNetworkEnvironment<T>(
  changes: Record<string, string | undefined>,
  action: () => Promise<T>,
): Promise<T> {
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "CHISEL_CERT_STORE",
    "CHISEL_CLIENT_CERT",
    "CHISEL_CLIENT_KEY",
    "CHISEL_CLIENT_CERT_HOSTS",
    "CHISEL_CLIENT_KEY_PASSPHRASE",
  ];
  const allNames = [...new Set([...names, ...Object.keys(changes)])];
  const saved = new Map(allNames.map((name) => [name, process.env[name]]));
  for (const name of allNames) delete process.env[name];
  for (const [name, value] of Object.entries(changes))
    if (value !== undefined) process.env[name] = value;
  try {
    return await action();
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}
