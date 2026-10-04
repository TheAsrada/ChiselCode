import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  NetworkConfigurationError,
  proxyForUrl,
  tlsForHost,
} from "./environment.js";
import { networkRequest } from "./request.js";

/** Streaming fetch for trusted SDK endpoints, with independent proxy and origin TLS. */
export async function networkFetch(request: Request): Promise<Response> {
  request.signal.throwIfAborted();
  const url = new URL(request.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new NetworkConfigurationError(
      "SDK endpoints must use HTTP(S) without embedded credentials.",
    );
  const proxy = proxyForUrl(url);
  const tls = await tlsForHost(url.hostname.replace(/^\[|\]$/g, ""));
  const proxyTls = proxy ? await tlsForHost(proxy.hostname) : undefined;
  request.signal.throwIfAborted();
  const pendingConnection = new AbortController();
  const connectionSignal = AbortSignal.any([
    request.signal,
    pendingConnection.signal,
  ]);
  return new Promise<Response>((resolve, reject) => {
    let incoming: IncomingMessage | undefined;
    let decoder: Transform | undefined;
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    let finished = false;
    let wireBytes = 0,
      decodedBytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let outgoing: ReturnType<typeof networkRequest> | undefined;
    const cleanup = () => request.signal.removeEventListener("abort", abort);
    const dispose = () =>
      setImmediate(() => {
        incoming?.unpipe();
        decoder?.destroy();
        if (incoming) {
          if (!incoming.complete) incoming.destroy();
        } else {
          if (!outgoing?.socket) pendingConnection.abort();
          outgoing?.destroy();
        }
      });
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      void reader?.cancel().catch(() => {});
      const failure = request.signal.aborted
        ? new DOMException("Network request cancelled.", "AbortError")
        : error instanceof NetworkConfigurationError
          ? error
          : new NetworkConfigurationError(
              "Network connection failed. Check proxy, CA certificates and mTLS configuration.",
            );
      if (settled) body?.error(failure);
      else reject(failure);
      dispose();
    };
    const abort = () =>
      fail(new DOMException("Network request cancelled.", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    try {
      const headers = Object.fromEntries(request.headers);
      delete headers["proxy-authorization"];
      const activeRequest = networkRequest(
        url,
        {
          ...tls,
          proxyTls,
          proxySignal: connectionSignal,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          method: request.method,
          maxHeaderSize: 32768,
          headers: { "Accept-Encoding": "gzip, deflate, br", ...headers },
        },
        (response) => {
          incoming = response;
          response.on("error", fail);
          response.on("aborted", () =>
            fail(
              new NetworkConfigurationError(
                "The network response was interrupted.",
              ),
            ),
          );
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (Array.isArray(value)) {
              for (const entry of value) responseHeaders.append(name, entry);
            } else if (value !== undefined) responseHeaders.set(name, value);
          const encoding = String(
            response.headers["content-encoding"] ?? "identity",
          )
            .trim()
            .toLowerCase();
          if (!["identity", "gzip", "deflate", "br"].includes(encoding)) {
            fail(
              new NetworkConfigurationError(
                "Unsupported network content encoding.",
              ),
            );
            return;
          }
          decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "deflate"
                ? createInflate()
                : encoding === "br"
                  ? createBrotliDecompress()
                  : undefined;
          if (decoder) {
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
            decoder.on("error", fail);
          }
          const source = decoder ?? response;
          response.on("data", (chunk: Buffer) => {
            wireBytes += chunk.length;
            if (wireBytes > 64 * 1024 * 1024)
              fail(
                new NetworkConfigurationError(
                  "Network response exceeds the byte limit.",
                ),
              );
          });
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              source.pause();
            },
            pull() {
              source.resume();
            },
            cancel() {
              if (!finished) {
                finished = true;
                cleanup();
                void reader?.cancel().catch(() => {});
                dispose();
              }
            },
          });
          source.on("data", (chunk: Buffer) => {
            if (finished) return;
            decodedBytes += chunk.length;
            if (decodedBytes > 64 * 1024 * 1024) {
              fail(
                new NetworkConfigurationError(
                  "Decoded network response exceeds the byte limit.",
                ),
              );
              return;
            }
            body?.enqueue(new Uint8Array(chunk));
            if ((body?.desiredSize ?? 0) <= 0) source.pause();
          });
          source.on("end", () => {
            if (finished) return;
            finished = true;
            cleanup();
            body?.close();
          });
          if (decoder) response.pipe(decoder);
          const status = response.statusCode ?? 502;
          const result = new Response(
            [204, 205, 304].includes(status) || request.method === "HEAD"
              ? null
              : stream,
            {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders,
            },
          );
          Object.defineProperty(result, "url", { value: url.toString() });
          settled = true;
          resolve(result);
          if (!result.body) response.resume();
        },
      );
      outgoing = activeRequest;
      activeRequest.on("error", fail);
      const send = async () => {
        if (request.body) {
          reader = request.body.getReader();
          try {
            while (!finished) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!activeRequest.write(value))
                await once(activeRequest, "drain");
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (!activeRequest.destroyed) activeRequest.end();
      };
      void send().catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}
