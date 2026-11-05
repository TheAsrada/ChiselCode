import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { enterpriseFetch } from "../../../network/fetch.js";
import type { ProviderConnection } from "../../../providers/contracts.js";
import { ProviderError } from "../../../providers/errors.js";
import {
  CredentialStore,
  credentialDirectory,
} from "../../../security/credentials.js";
import { withLock } from "../../../sessions/lock.js";
import { readChatGptJson } from "./transport.js";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().min(1),
  expiresAt: z.number().finite(),
  label: z.string().optional(),
});
export type ChatGptSession = z.infer<typeof SessionSchema>;
const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
});
export type ChatGptFetch = typeof enterpriseFetch;
export interface ChatGptAuthOptions {
  fetch?: ChatGptFetch;
  credentials?: Pick<CredentialStore, "get" | "set" | "delete">;
  lockDirectory?: string;
}
function claims(token?: string): Record<string, unknown> {
  try {
    return JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
    );
  } catch {
    return {};
  }
}
function identity(token?: string): Record<string, unknown> {
  const value = claims(token)["https://api.openai.com/auth"];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function loginRequired(): ProviderError {
  return new ProviderError(
    "authentication",
    "Войдите в ChatGPT в настройках подключения.",
  );
}
export class ChatGptAuth implements ProviderConnection {
  private readonly fetch: ChatGptFetch;
  private readonly credentials: Pick<CredentialStore, "get" | "set" | "delete">;
  private readonly locks: string;
  private statuses = new Map<string, { connected: boolean; label?: string }>();
  knownStatus(profileId: string) {
    return this.statuses.get(profileId);
  }
  constructor(options: ChatGptAuthOptions = {}) {
    this.fetch = options.fetch ?? enterpriseFetch;
    this.credentials = options.credentials ?? new CredentialStore();
    this.locks = options.lockDirectory ?? credentialDirectory();
  }
  private key(profileId: string) {
    return `subscription:chatgpt:${profileId}`;
  }
  private async read(profileId: string): Promise<ChatGptSession | undefined> {
    const raw = await this.credentials.get(this.key(profileId));
    if (!raw) return;
    try {
      return SessionSchema.parse(JSON.parse(raw));
    } catch {
      throw loginRequired();
    }
  }
  private async locked<T>(
    profileId: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await mkdir(this.locks, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(this.key(profileId))
      .digest("hex")
      .slice(0, 24);
    return withLock(join(this.locks, `chatgpt-${key}`), work, signal);
  }
  async status(profileId: string) {
    const session = await this.read(profileId);
    const status = { connected: !!session, label: session?.label };
    this.statuses.set(profileId, status);
    return status;
  }
  private async request(
    path: string,
    body: object | URLSearchParams,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const response = await this.fetch(`${ISSUER}${path}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "Content-Type":
          body instanceof URLSearchParams
            ? "application/x-www-form-urlencoded"
            : "application/json",
      },
      body: body instanceof URLSearchParams ? body : JSON.stringify(body),
    });
    return response;
  }
  private session(raw: unknown, previous?: ChatGptSession): ChatGptSession {
    const token = TokenSchema.parse(raw);
    const info = {
      ...identity(token.access_token),
      ...identity(token.id_token),
    };
    const accountId =
      typeof info.chatgpt_account_id === "string"
        ? info.chatgpt_account_id
        : previous?.accountId;
    const label = claims(token.id_token).email;
    const exp = claims(token.access_token).exp;
    return SessionSchema.parse({
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? previous?.refreshToken,
      accountId,
      label: typeof label === "string" ? label : previous?.label,
      expiresAt: token.expires_in
        ? Date.now() + token.expires_in * 1000
        : typeof exp === "number"
          ? exp * 1000
          : Date.now() + 3600_000,
    });
  }
  async connect(input: Parameters<ProviderConnection["connect"]>[0]) {
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(15 * 60_000),
    ]);
    const started = await this.request(
      "/api/accounts/deviceauth/usercode",
      { client_id: CLIENT_ID },
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    );
    if (!started.ok) {
      await started.body?.cancel();
      throw new ProviderError(
        "authentication",
        `Не удалось начать вход в ChatGPT (HTTP ${started.status}). Проверьте доступность входа по коду в настройках безопасности ChatGPT.`,
      );
    }
    const device = z
      .object({
        device_auth_id: z.string().min(1),
        user_code: z.string().optional(),
        usercode: z.string().optional(),
        interval: z.coerce.number().nonnegative().optional(),
      })
      .parse(await readChatGptJson(started));
    const code = device.user_code ?? device.usercode;
    if (!code)
      throw new ProviderError("authentication", "ChatGPT не вернул код входа.");
    input.challenge({
      url: `${ISSUER}/codex/device`,
      code,
      expiresAt: Date.now() + 15 * 60_000,
    });
    for (;;) {
      signal.throwIfAborted();
      const response = await this.request(
        "/api/accounts/deviceauth/token",
        { device_auth_id: device.device_auth_id, user_code: code },
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      );
      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        await delay(
          Math.max(1, Math.min(60, device.interval ?? 5)) * 1000,
          undefined,
          { signal },
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(
          "authentication",
          `Вход в ChatGPT не завершён (HTTP ${response.status}). Повторите подключение.`,
        );
      }
      const grant = z
        .object({ authorization_code: z.string(), code_verifier: z.string() })
        .parse(await readChatGptJson(response));
      const exchanged = await this.request(
        "/oauth/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: grant.authorization_code,
          code_verifier: grant.code_verifier,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
        }),
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      );
      if (!exchanged.ok) {
        await exchanged.body?.cancel();
        throw new ProviderError(
          "authentication",
          "ChatGPT отклонил вход. Получите новый код.",
        );
      }
      const session = this.session(await readChatGptJson(exchanged));
      await this.locked(
        input.profileId,
        async () => {
          signal.throwIfAborted();
          await this.credentials.set(
            this.key(input.profileId),
            JSON.stringify(session),
          );
        },
        signal,
      );
      const status = { connected: true, label: session.label };
      this.statuses.set(input.profileId, status);
      return status;
    }
  }
  async disconnect(profileId: string) {
    await this.locked(profileId, () =>
      this.credentials.delete(this.key(profileId)),
    );
    this.statuses.set(profileId, { connected: false });
  }
  async sessionFor(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ChatGptSession> {
    signal?.throwIfAborted();
    const current = await this.read(profileId);
    if (!current) throw loginRequired();
    if (current.expiresAt > Date.now() + 60_000) return current;
    return this.locked(
      profileId,
      async () => {
        const latest = await this.read(profileId);
        if (!latest) throw loginRequired();
        if (latest.expiresAt > Date.now() + 60_000) return latest;
        const response = await this.request(
          "/oauth/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: latest.refreshToken,
          }),
          AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(20_000),
          ]),
        );
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 400 || response.status === 401)
            throw loginRequired();
          throw new ProviderError(
            "unavailable",
            `Не удалось обновить вход в ChatGPT (HTTP ${response.status}).`,
          );
        }
        const refreshed = this.session(await readChatGptJson(response), latest);
        signal?.throwIfAborted();
        await this.credentials.set(
          this.key(profileId),
          JSON.stringify(refreshed),
        );
        return refreshed;
      },
      signal,
    );
  }
}
