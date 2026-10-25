import { retryAfterMs } from "../network/retry.js";
import { RuntimeError } from "../runtime/errors.js";
import type { SafeWebHttpClient, WebHttpOptions } from "../web/http-client.js";
import { utf8 } from "./package.js";

type Stage = "commit" | "tree" | "blob";
const labels = {
  commit: "получение коммита",
  tree: "чтение дерева файлов",
  blob: "скачивание файла",
};

/** Only GitHub API JSON errors are exposed, bounded and quoted as service data.
 * Arbitrary HTML bodies, credentials and other response fields stay private. */
export async function githubSkillJson(
  http: SafeWebHttpClient,
  url: string,
  options: WebHttpOptions,
  stage: Stage,
  revision?: string,
): Promise<unknown> {
  const response = await http.get(url, {
    ...options,
    acceptHttpErrors: true,
    captureErrorJson: true,
  });
  const status = response.status ?? 200;
  if (status >= 200 && status < 300) return JSON.parse(utf8(response.bytes));
  let apiMessage: string | undefined;
  try {
    const body: unknown = JSON.parse(utf8(response.bytes));
    if (
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
    )
      apiMessage = Array.from(
        body.message.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim(),
      )
        .slice(0, 400)
        .join("");
  } catch {
    /* Do not echo non-JSON responses or error pages. */
  }
  const invalidRevision =
    status === 422 &&
    stage === "tree" &&
    revision &&
    /invalid object|sha.*(?:commit|tree)/i.test(apiMessage ?? "");
  const retry = retryAfterMs(response.headers?.["retry-after"]);
  throw new RuntimeError(
    invalidRevision
      ? "INVALID_TOOL_INPUT"
      : status === 429
        ? "WEB_RATE_LIMITED"
        : "WEB_HTTP_ERROR",
    `GitHub API, ${labels[stage]}: HTTP ${status}.${apiMessage ? ` Причина API: ${JSON.stringify(apiMessage)}.` : " API не сообщил текстовую причину."}${retry === undefined ? "" : ` Retry-After: не раньше чем через ${Math.ceil(retry / 1000)} с.`}${invalidRevision ? " Поле revision не указывает на коммит или дерево этого источника. Если пользователь не задавал SHA, уберите revision или передайте null; клиент определит коммит сам. Явно заданную пользователем версию не заменяйте другой." : status === 404 ? " Проверьте источник и указанную версию: GitHub также возвращает 404 для недоступных репозиториев." : status === 403 || status === 429 ? " Проверьте доступ и ограничения GitHub; повтор того же запроса без изменения условий не поможет." : ""}`,
    {
      status,
      hostname: "api.github.com",
      stage,
      ...(apiMessage ? { apiMessage } : {}),
      ...(revision ? { revision } : {}),
      retryable: status === 429 || status >= 500,
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
    },
  );
}
