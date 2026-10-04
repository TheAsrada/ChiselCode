import { enterpriseFetch } from "../network/fetch.js";
import { RuntimeError } from "../runtime/errors.js";

/** Bound HTTP/SSE payloads without implementing or inspecting MCP framing. */
export async function boundedMcpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await enterpriseFetch(input, init);
  const maximum = 16 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new RuntimeError(
      "MCP_PROTOCOL_ERROR",
      "Ответ MCP превышает лимит 16 MiB.",
      { retryable: false },
    );
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum)
          throw new RuntimeError(
            "MCP_PROTOCOL_ERROR",
            "Ответ MCP превышает лимит 16 MiB.",
            { retryable: false },
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
