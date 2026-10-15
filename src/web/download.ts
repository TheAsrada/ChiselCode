import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { chiselHomeDir } from "../paths/home.js";
import { userFolder } from "../paths/user-folders.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";
import { defineTool } from "../tools/handler.js";
import type { ToolContext, ToolHandler, ToolPlan } from "../tools/types.js";
import { workspaceCoordinator } from "../tools/workspace-coordinator.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";
import type { WebConfig } from "./schema.js";
import { urlHostname } from "./url-policy.js";

const filename = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (name) =>
      !/[<>:"/\\|?*]/.test(name) &&
      [...name].every((character) => character.charCodeAt(0) >= 32) &&
      !/[. ]$/.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
  );
export const DownloadInputSchema = z
  .strictObject({
    url: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
    directory: z.enum(["desktop", "downloads"]).optional(),
    filename: filename.optional(),
    overwrite: z.boolean().default(false),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .optional(),
  })
  .refine(
    (input) =>
      input.path
        ? !input.directory && !input.filename
        : Boolean(input.directory && input.filename),
    "Укажите path внутри проекта либо directory и filename.",
  );
type DownloadInput = z.output<typeof DownloadInputSchema>;
interface Target {
  path: string;
  original: string;
  revision?: string;
}
const handlers = new WeakSet<ToolHandler>();
const plans = new WeakMap<ToolPlan, Target>();
export const isNativeDownload = (handler: ToolHandler) => handlers.has(handler);

async function canonicalDestination(path: string): Promise<string> {
  let parent = dirname(path);
  for (;;) {
    try {
      return resolve(await realpath(parent), relative(parent, path));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(parent) === parent
      )
        throw error;
      parent = dirname(parent);
    }
  }
}
async function revision(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink())
      throw new RuntimeError(
        "WEB_DOWNLOAD_CONFLICT",
        "Назначение должно быть обычным файлом, не каталогом или ссылкой.",
      );
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(
      ":",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function target(
  context: ToolContext,
  input: DownloadInput,
): Promise<Target> {
  if (input.directory && context.session.subagent)
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Помощник может скачивать только внутрь своей рабочей копии; экспорт на рабочий стол выполняет основной агент.",
    );
  const original = input.path
    ? await context.workspace.resolve(input.path)
    : join(await userFolder(input.directory!, context.signal), input.filename!);
  const path = await canonicalDestination(original);
  const current = await revision(path);
  if (current && !input.overwrite)
    throw new RuntimeError(
      "WEB_TARGET_EXISTS",
      `Файл уже существует: ${path}. Выберите другое имя; overwrite по умолчанию выключен.`,
    );
  return { path, original, revision: current };
}

export function downloadTool(
  http: SafeWebHttpClient,
  config: WebConfig,
  requestOptions: (context: ToolContext) => WebHttpOptions,
): ToolHandler {
  const handler = defineTool(
    {
      name: "web_download",
      source: { type: "web", operation: "download" },
      effect: "workspace_write",
      permission: "write",
      parallelSafe: true,
      workspaceAccess: "none",
      timeoutMs: config.limits.downloadTimeoutMs + 2000,
      outputPolicy: { maxInlineTokens: 1000 },
      description:
        "Download a public HTTP(S) file without shell. Use path inside the project, or directory desktop/downloads and a filename: core resolves the real OS folder, including OneDrive/XDG. Streams atomically with bounded retries, progress and cancellation. Existing files are preserved unless overwrite is explicitly true. Returns actual absolute path, bytes, media type and SHA-256; no binary content. Build only. Coding subagents may write only in their own copy.",
      guidance:
        "Use web_download for images, archives and other files instead of shell/PowerShell download commands. For the user's desktop/downloads use directory=desktop/downloads, never guess a home/OneDrive/localized path. Discover and verify a direct public source with web_search/web_fetch. A readonly subagent can find the source; the main agent exports the file. A download does not execute or trust its contents. Do not repeat persistent 429/403 errors: use a different permitted source. Report success only from the verified download result and its actual path.",
    },
    DownloadInputSchema,
    async (context, input) => {
      const url = http.policy.normalize(input.url);
      const destination = await target(context, input);
      const plan = {
        data: { ...input, url: url.toString() },
        resources: [destination.path],
        preview: `Скачать файл\n${url}\nСохранить: ${destination.path}\n${input.overwrite ? "Перезапись разрешена только для неизменившегося файла." : "Существующий файл не перезаписывается."}\nМаксимум: ${Math.min(input.maxBytes ?? config.limits.maxDownloadBytes, config.limits.maxDownloadBytes)} байт.`,
        network: {
          operation: "fetch" as const,
          hostname: urlHostname(url),
          url: url.toString(),
        },
      };
      plans.set(plan, destination);
      return plan;
    },
    async (context, plan) => {
      const destination = plans.get(plan);
      if (!destination || !context.networkAuthorization)
        throw new RuntimeError(
          "PERMISSION_DENIED",
          "Скачивание требует подготовленного core плана и сетевого разрешения.",
        );
      const input = plan.data;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        config.limits.downloadTimeoutMs,
      );
      const signal = context.signal
        ? AbortSignal.any([context.signal, timeout.signal])
        : timeout.signal;
      const deadline = Date.now() + config.limits.downloadTimeoutMs;
      let temporary: string | undefined;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let received = 0,
        total: number | undefined,
        lastProgress = 0;
      const progress = async (force = false) => {
        if (!force && Date.now() - lastProgress < 200) return;
        lastProgress = Date.now();
        await context.events.emit({
          type: "tool_progress",
          invocationId: context.invocationId,
          name: "web_download",
          progress: received,
          total,
          text: `Скачано ${received}${total === undefined ? "" : ` / ${total}`} байт`,
        });
      };
      try {
        cancelled(signal);
        if (
          (await canonicalDestination(destination.original)) !==
          destination.path
        )
          throw new RuntimeError(
            "WEB_DOWNLOAD_CONFLICT",
            "Каталог назначения изменился после подтверждения.",
          );
        if (input.path) await context.workspace.resolve(input.path);
        await mkdir(dirname(destination.path), { recursive: true });
        if (
          (await canonicalDestination(destination.original)) !==
          destination.path
        )
          throw new RuntimeError(
            "WEB_DOWNLOAD_CONFLICT",
            "Каталог назначения изменился.",
          );
        temporary = join(
          dirname(destination.path),
          `.${basename(destination.path)}.${randomUUID()}.download`,
        );
        file = await open(temporary, "wx", 0o600);
        const options = requestOptions(context);
        let response: Awaited<ReturnType<SafeWebHttpClient["get"]>> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          cancelled(signal);
          received = 0;
          total = undefined;
          await file.truncate(0);
          try {
            response = await http.get(input.url, {
              ...options,
              signal,
              timeoutMs: Math.max(1, deadline - Date.now()),
              headers: { Accept: "*/*", "Accept-Encoding": "identity" },
              bodySink: {
                maxBytes: Math.min(
                  input.maxBytes ?? config.limits.maxDownloadBytes,
                  config.limits.maxDownloadBytes,
                ),
                start(length) {
                  total = length;
                },
                async write(chunk) {
                  cancelled(signal);
                  try {
                    for (let offset = 0; offset < chunk.length; ) {
                      const written = await file!.write(
                        chunk,
                        offset,
                        chunk.length - offset,
                        received,
                      );
                      if (!written.bytesWritten)
                        throw new Error("Запись не продвинулась");
                      offset += written.bytesWritten;
                      received += written.bytesWritten;
                    }
                    await progress();
                  } catch (error) {
                    cancelled(signal);
                    throw new RuntimeError(
                      "WEB_DOWNLOAD_FAILED",
                      `Не удалось сохранить данные: ${error instanceof Error ? error.message : "ошибка записи"}`,
                      { retryable: false },
                    );
                  }
                },
              },
            });
            break;
          } catch (error) {
            cancelled(signal);
            if (
              !(error instanceof RuntimeError) ||
              error.details?.retryable !== true ||
              attempt === 2
            )
              throw error;
            const wait =
              typeof error.details.retryAfterMs === "number" &&
              Number.isFinite(error.details.retryAfterMs)
                ? error.details.retryAfterMs
                : 250 * 2 ** attempt;
            if (wait >= deadline - Date.now())
              throw new RuntimeError(
                error.code,
                "Источник просит ждать дольше допустимого времени скачивания. Выберите другой источник.",
                error.details,
              );
            await context.events.emit({
              type: "tool_progress",
              name: "web_download",
              invocationId: context.invocationId,
              text: `Временный отказ источника; повтор ${attempt + 2}/3 через ${wait} мс`,
            });
            await delay(wait, undefined, { signal });
          }
        }
        if (!response)
          throw new RuntimeError(
            "WEB_DOWNLOAD_FAILED",
            "Источник не вернул файл; выберите другой источник.",
          );
        await file.sync();
        await file.close();
        file = undefined;
        // Verify the saved bytes before publishing, without putting binary data in context.
        const hash = createHash("sha256");
        let verifiedBytes = 0;
        for await (const chunk of createReadStream(temporary, { signal })) {
          hash.update(chunk);
          verifiedBytes += chunk.length;
        }
        if (verifiedBytes !== received)
          throw new RuntimeError(
            "WEB_DOWNLOAD_FAILED",
            "Размер сохранённого файла не совпадает с принятыми данными.",
          );
        const sha256 = hash.digest("hex");
        const access = [
          {
            resource: (
              await workspaceCoordinator.resources([destination.path])
            )[0]!,
            mode: "write" as const,
          },
        ];
        await context.background?.assertAccess(
          access,
          context.backgroundExecution,
        );
        const lease = context.background
          ? await context.background.acquireAccess(access, signal)
          : await workspaceCoordinator.acquirePlanLease(access, signal);
        try {
          const locks = join(chiselHomeDir(), "web-download-locks");
          await mkdir(locks, { recursive: true, mode: 0o700 });
          await withLock(
            join(
              locks,
              createHash("sha256").update(access[0]!.resource).digest("hex"),
            ),
            async (assertOwned) => {
              cancelled(signal);
              if (
                (await canonicalDestination(destination.original)) !==
                  destination.path ||
                (await revision(destination.path)) !== destination.revision
              )
                throw new RuntimeError(
                  "WEB_DOWNLOAD_CONFLICT",
                  "Файл или каталог изменился во время скачивания; чужие изменения сохранены.",
                );
              if (input.path) await context.workspace.resolve(input.path);
              await assertOwned();
              cancelled(signal);
              if (input.overwrite) await rename(temporary!, destination.path);
              else
                try {
                  await link(temporary!, destination.path);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "EEXIST")
                    throw new RuntimeError(
                      "WEB_TARGET_EXISTS",
                      "Файл создан другим вызовом; он не перезаписан.",
                    );
                  throw error;
                }
              workspaceCoordinator.changed([access[0]!.resource]);
            },
            signal,
          );
        } finally {
          await lease.finish();
        }
        const path = await realpath(destination.path);
        const saved = await lstat(path);
        if (saved.size !== verifiedBytes)
          throw new RuntimeError(
            "WEB_DOWNLOAD_CONFLICT",
            "После сохранения размер файла изменился; успех не подтверждён.",
          );
        await progress(true);
        const result = {
          path,
          bytes: verifiedBytes,
          contentType: response.contentType || "application/octet-stream",
          sha256,
          finalUrl: response.finalUrl,
        };
        return {
          output: JSON.stringify(result),
          contentTrust: "untrusted_external" as const,
          details: { web: { action: "download", ...result } },
          references: [{ uri: response.finalUrl, kind: "opened" as const }],
        };
      } catch (error) {
        cancelled(context.signal);
        if (timeout.signal.aborted)
          throw new RuntimeError(
            "WEB_TIMEOUT",
            "Скачивание превысило общее время; файл не подтверждён.",
          );
        if (error instanceof RuntimeError && error.details?.retryable)
          throw new RuntimeError(
            error.code,
            `${error.message} Повторы исчерпаны; выберите другой источник.`,
            { ...error.details, retryable: false },
          );
        throw error;
      } finally {
        clearTimeout(timer);
        await file?.close();
        if (temporary) await rm(temporary, { force: true });
      }
    },
  );
  handlers.add(handler);
  return handler;
}
