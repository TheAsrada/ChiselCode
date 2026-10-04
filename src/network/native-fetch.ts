import { NetworkConfigurationError, type NetworkTls } from "./environment.js";

/** Bun's native stream lifecycle avoids node:http/Web Streams teardown races. */
export async function directFetch(
  request: Request,
  tls: NetworkTls,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("proxy-authorization");
  let response: Response;
  try {
    response = await fetch(request, {
      headers,
      tls,
      proxy: "",
      redirect: "manual",
      verbose: false,
    });
  } catch {
    if (request.signal.aborted)
      throw new DOMException("Network request cancelled.", "AbortError");
    throw new NetworkConfigurationError(
      "Network connection failed. Check CA certificates and mTLS configuration.",
    );
  }
  const maximum = 64 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new NetworkConfigurationError(
      "Network response exceeds the byte limit.",
    );
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum)
          throw new NetworkConfigurationError(
            "Decoded network response exceeds the byte limit.",
          );
        controller.enqueue(chunk);
      },
    }),
  );
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(bounded, "url", { value: response.url });
  return bounded;
}
