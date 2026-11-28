import { z } from "zod";
import { enterpriseFetch } from "../../../network/fetch.js";
import {
  normalizeProviderError,
  ProviderError,
} from "../../../providers/errors.js";
import type { ChatGptAuth, ChatGptFetch } from "./auth.js";

const BASE = "https://chatgpt.com/backend-api";
export class ChatGptTransport {
  constructor(
    readonly auth: ChatGptAuth,
    private fetch: ChatGptFetch = enterpriseFetch,
  ) {}
  async request(profileId: string, path: string, init: RequestInit = {}) {
    const signal = init.signal ?? undefined;
    const session = await this.auth.sessionFor(profileId, signal);
    const response = await this.fetch(`${BASE}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "ChatGPT-Account-Id": session.accountId,
        originator: "chiselcode",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await readChatGptJson(response).catch(() => undefined);
      signal?.throwIfAborted();
      throw chatGptResponseError(body, response.headers, response.status);
    }
    return response;
  }
}
/** Only retain structured error metadata from the subscription endpoint. */
export function chatGptResponseError(
  value: unknown,
  headers: Headers,
  status?: number,
): ProviderError {
  const details = z.object({
    code: z.union([z.string(), z.number()]).nullish(),
    type: z.string().nullish(),
  });
  const envelope = details
    .extend({
      error: z.union([z.string(), details]).nullish(),
      detail: z.union([z.string(), details]).nullish(),
    })
    .safeParse(value);
  const error = envelope.data?.error ?? envelope.data?.detail ?? envelope.data;
  const failure = normalizeProviderError({
    error: typeof error === "string" ? { code: error } : error,
    headers,
    status,
  });
  // The subscription endpoint also uses a bare 429 for exhausted plan limits.
  const code =
    status === 429 && !failure.upstreamCode ? "quota_exhausted" : failure.code;
  const message =
    code === "authentication"
      ? "ChatGPT отклонил подключение. Войдите в профиль заново."
      : code === "quota_exhausted"
        ? "Лимит подписки ChatGPT исчерпан. Дождитесь сброса лимита."
        : code === "context_overflow"
          ? "Превышено окно контекста ChatGPT."
          : status === undefined
            ? "ChatGPT не завершил ответ."
            : `Ошибка ChatGPT (HTTP ${status}).`;
  return new ProviderError(
    code,
    message,
    status,
    code === failure.code ? failure.retryable : false,
    failure.retryAfterMs,
    failure.upstreamCode,
  );
}
/** Bounded SSE frames, including multiline data and CRLF. Reader is cancelled on every exit. */
export async function* responseEvents(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body)
    throw new ProviderError("transport", "ChatGPT вернул пустой поток.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024)
        throw new ProviderError("transport", "Слишком большой кадр ChatGPT.");
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          throw new ProviderError("transport", "Некорректный поток ChatGPT.");
        }
        yield z.record(z.string(), z.unknown()).parse(event);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Authentication/catalog bodies are bounded and never included in error messages. */
export async function readChatGptJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new ProviderError("transport", "ChatGPT вернул пустой ответ.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new ProviderError("transport", "Слишком большой ответ ChatGPT.");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderError("transport", "Некорректный ответ ChatGPT.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
