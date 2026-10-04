import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { NetworkAuthorization } from "../security/network-policy.js";
import type { WebLimits } from "./schema.js";
import { type ResolvedUrl, UrlPolicy, urlHostname } from "./url-policy.js";

export interface WebResponse {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  bytes: Uint8Array;
  redirects: string[];
}
export interface WebHttpOptions {
  signal?: AbortSignal;
  authorization: NetworkAuthorization;
  beforeRequest?: (signal: AbortSignal) => Promise<() => void>;
  headers?: Record<string, string>;
  maxRedirects?: number;
}
/** Narrow transport seam for deterministic local-server fixtures. */
export type PinnedRequest = (
  target: ResolvedUrl,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ReturnType<typeof httpRequest>;
export function pinnedRequestOptions(
  target: ResolvedUrl,
  options: RequestOptions,
) {
  const hostname = urlHostname(target.url);
  const address = [...target.addresses].sort((a, b) => a.family - b.family)[0];
  if (!address)
    throw new RuntimeError(
      "WEB_UNSAFE_ADDRESS",
      "No verified address is available.",
    );
  const tls = target.url.protocol === "https:";
  // Connect to the verified IP itself: the HTTP stack never resolves the hostname again.
  // Host/SNI and certificate identity still refer to the original public URL.
  const settings = {
    ...options,
    hostname: address.address,
    port: target.url.port || (tls ? 443 : 80),
    path: target.url.pathname + target.url.search,
    agent: false as const,
    headers: { ...options.headers, Host: target.url.host },
    ...(tls
      ? {
          servername:
            hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
              ? undefined
              : hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (
            _host: string,
            cert: Parameters<typeof checkServerIdentity>[1],
          ) => checkServerIdentity(hostname, cert),
        }
      : {}),
  };
  return settings;
}
export const pinnedRequest: PinnedRequest = (target, options, onResponse) =>
  (target.url.protocol === "https:" ? httpsRequest : httpRequest)(
    pinnedRequestOptions(target, options),
    onResponse,
  );

export class SafeWebHttpClient {
  constructor(
    readonly limits: WebLimits,
    readonly policy = new UrlPolicy(),
    private readonly transport: PinnedRequest = pinnedRequest,
  ) {}
  async get(input: string, options: WebHttpOptions): Promise<WebResponse> {
    cancelled(options.signal);
    const requestedUrl = this.policy.normalize(input).toString();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      this.limits.requestTimeoutMs,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    let current = requestedUrl;
    const seen = new Set<string>();
    const redirects: string[] = [];
    try {
      while (true) {
        cancelled(signal);
        if (seen.has(current))
          throw new RuntimeError(
            "WEB_REDIRECT_LIMIT",
            "Redirect loop detected.",
            { retryable: false },
          );
        seen.add(current);
        const normalized = this.policy.normalize(current);
        options.authorization.assertDestination(urlHostname(normalized));
        const target = await this.policy.resolve(current, signal);
        const release = await options.beforeRequest?.(signal);
        try {
          cancelled(signal);
          options.authorization.assertDestination(urlHostname(target.url));
          const response = await this.request(target, signal, options.headers);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (
              redirects.length >=
              (options.maxRedirects ?? this.limits.maxRedirects)
            )
              throw new RuntimeError(
                "WEB_REDIRECT_LIMIT",
                "Maximum redirect count reached.",
                { retryable: false },
              );
            if (!response.location)
              throw new RuntimeError(
                "WEB_PROTOCOL_ERROR",
                "Redirect has no valid Location header.",
              );
            let destination: URL;
            try {
              destination = new URL(response.location, current);
            } catch {
              throw new RuntimeError(
                "WEB_PROTOCOL_ERROR",
                "Redirect contains an invalid URL.",
              );
            }
            current = this.policy.normalize(destination.toString()).toString();
            redirects.push(current);
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            throw new RuntimeError(
              response.status === 429 ? "WEB_RATE_LIMITED" : "WEB_HTTP_ERROR",
              `Web request returned HTTP ${response.status}.`,
              {
                status: response.status,
                retryable: response.status === 429 || response.status >= 500,
                ...(response.retryAfterMs
                  ? { retryAfterMs: response.retryAfterMs }
                  : {}),
              },
            );
          }
          return {
            requestedUrl,
            finalUrl: current,
            contentType: response.contentType,
            bytes: response.bytes,
            redirects,
          };
        } finally {
          release?.();
        }
      }
    } catch (error) {
      cancelled(options.signal);
      if (timeout.signal.aborted)
        throw new RuntimeError(
          "WEB_TIMEOUT",
          "Web request exceeded its total timeout.",
          { retryable: true },
        );
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "WEB_FETCH_FAILED",
        "Could not connect securely to the public web server.",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private async request(
    target: ResolvedUrl,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<{
    status: number;
    contentType: string;
    bytes: Uint8Array;
    location?: string;
    retryAfterMs?: number;
  }> {
    return new Promise((resolve, reject) => {
      let finished = false;
      let response: IncomingMessage | undefined;
      let decoder: Transform | undefined;
      let encoded: Transform | undefined;
      let request: ReturnType<typeof httpRequest> | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (connectTimer) clearTimeout(connectTimer);
        signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        decoder?.destroy();
        encoded?.destroy();
        response?.destroy();
        request?.destroy();
        reject(
          error instanceof RuntimeError
            ? error
            : new RuntimeError(
                response ? "WEB_PROTOCOL_ERROR" : "WEB_FETCH_FAILED",
                response
                  ? "The web server returned an invalid or interrupted response."
                  : "Could not establish a secure connection to the public web server.",
                {
                  retryable: true,
                  reason: response
                    ? "interrupted_response"
                    : "connection_failed",
                },
              ),
        );
      };
      const done = (result: {
        status: number;
        contentType: string;
        bytes: Uint8Array;
        location?: string;
        retryAfterMs?: number;
      }) => {
        if (finished) return;
        finished = true;
        cleanup();
        response?.destroy();
        request?.destroy();
        decoder?.destroy();
        encoded?.destroy();
        resolve(result);
      };
      const abort = () =>
        fail(new RuntimeError("CANCELLED", "Web request cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        request = this.transport(
          target,
          {
            method: "GET",
            maxHeaderSize: 16384,
            headers: {
              "User-Agent": "ChiselCode-Web/1",
              Accept:
                "text/html, text/plain, text/markdown, application/json;q=0.9",
              "Accept-Encoding": "gzip, deflate, br",
              ...headers,
            },
          },
          (incoming) => {
            response = incoming;
            if (connectTimer) clearTimeout(connectTimer);
            const status = incoming.statusCode ?? 0;
            const contentType = String(incoming.headers["content-type"] ?? "");
            const location =
              typeof incoming.headers.location === "string"
                ? incoming.headers.location
                : undefined;
            const retryAfter = incoming.headers["retry-after"];
            const retryAfterMs =
              typeof retryAfter === "string"
                ? Math.min(
                    60000,
                    Math.max(
                      0,
                      /^\d+$/.test(retryAfter)
                        ? Number(retryAfter) * 1000
                        : Date.parse(retryAfter) - Date.now(),
                    ),
                  )
                : undefined;
            if (status < 200 || status >= 300) {
              done({
                status,
                contentType,
                location,
                retryAfterMs,
                bytes: new Uint8Array(),
              });
              return;
            }
            const length = Number(incoming.headers["content-length"]);
            if (
              Number.isFinite(length) &&
              length > this.limits.maxResponseBytes
            ) {
              fail(
                new RuntimeError(
                  "WEB_TOO_LARGE",
                  "Web response exceeds the wire byte limit.",
                ),
              );
              return;
            }
            const encoding = String(
              incoming.headers["content-encoding"] ?? "identity",
            )
              .trim()
              .toLowerCase();
            if (!["identity", "gzip", "deflate", "br"].includes(encoding)) {
              fail(
                new RuntimeError(
                  "WEB_UNSUPPORTED_CONTENT",
                  "Unsupported web content encoding.",
                ),
              );
              return;
            }
            let wireBytes = 0;
            encoded = new Transform({
              transform: (chunk: Buffer, _encoding, callback) => {
                wireBytes += chunk.length;
                callback(
                  wireBytes > this.limits.maxResponseBytes
                    ? new RuntimeError(
                        "WEB_TOO_LARGE",
                        "Web response exceeds the wire byte limit.",
                      )
                    : null,
                  chunk,
                );
              },
            });
            decoder =
              encoding === "gzip"
                ? createGunzip()
                : encoding === "deflate"
                  ? createInflate()
                  : encoding === "br"
                    ? createBrotliDecompress()
                    : new Transform({
                        transform: (chunk, _encoding, callback) =>
                          callback(null, chunk),
                      });
            incoming.on("error", fail);
            encoded.on("error", fail);
            decoder.on("error", fail);
            const chunks: Buffer[] = [];
            let size = 0;
            decoder.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > this.limits.maxDecompressedBytes) {
                fail(
                  new RuntimeError(
                    "WEB_TOO_LARGE",
                    "Web response exceeds the decompressed byte limit.",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            decoder.on("end", () =>
              done({ status, contentType, bytes: Buffer.concat(chunks, size) }),
            );
            incoming.pipe(encoded).pipe(decoder);
          },
        );
        request.on("error", (error) => fail(error));
        // Covers TCP/TLS and the wait for response headers; total timeout also covers DNS/body.
        connectTimer = setTimeout(
          () =>
            fail(
              new RuntimeError(
                "WEB_TIMEOUT",
                "Web connection or response headers timed out.",
                { retryable: true },
              ),
            ),
          this.limits.connectTimeoutMs,
        );
        request.end();
      } catch (error) {
        fail(error);
      }
    });
  }
}
