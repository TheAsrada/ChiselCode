import { z } from "zod";
import type { UiSnapshot } from "../../ui-types.js";
import { type ChatGptTransport, readChatGptJson } from "./transport.js";

const Window = z.object({
  used_percent: z.number().finite().min(0).max(100),
  limit_window_seconds: z.number().positive().optional(),
  reset_at: z.number().nonnegative().optional(),
});
const Usage = z.object({
  plan_type: z.string().optional(),
  rate_limit: z
    .object({
      primary_window: Window.nullish(),
      secondary_window: Window.nullish(),
    })
    .nullish(),
});
export interface UsageWindow {
  id: string;
  remaining: number;
  seconds?: number;
  resetsAt?: number;
  observedAt?: number;
}
export interface UsageSnapshot {
  revision: number;
  observedAt?: number;
  plan?: string;
  windows: UsageWindow[];
  error?: boolean;
}
const TTL = 60_000;
export class ChatGptUsage {
  private cache = new Map<string, UsageSnapshot>();
  private pending = new Map<string, Promise<UsageSnapshot>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private epochs = new Map<string, number>();
  constructor(private transport: ChatGptTransport) {}
  peek(profile: string) {
    return this.cache.get(profile);
  }
  subscribe(changed: () => void) {
    this.listeners.add(changed);
    return {
      dispose: () => {
        this.listeners.delete(changed);
      },
    };
  }
  private publish(profile: string, value: Omit<UsageSnapshot, "revision">) {
    const snapshot = { ...value, revision: ++this.revision };
    this.cache.set(profile, snapshot);
    for (const changed of this.listeners) changed();
    return snapshot;
  }
  unavailable(profile: string) {
    const previous = this.cache.get(profile);
    return this.publish(profile, {
      ...previous,
      windows: previous?.windows ?? [],
      error: true,
      observedAt: Date.now(),
    });
  }
  clear(profile: string) {
    this.epochs.set(profile, (this.epochs.get(profile) ?? 0) + 1);
    this.cache.delete(profile);
    for (const changed of this.listeners) changed();
  }
  async read(profile: string, signal?: AbortSignal): Promise<UsageSnapshot> {
    const previous = this.cache.get(profile);
    if (previous?.observedAt && Date.now() - previous.observedAt < TTL)
      return previous;
    const pending = this.pending.get(profile);
    if (pending) return pending;
    const operation = this.load(profile, signal).finally(() =>
      this.pending.delete(profile),
    );
    this.pending.set(profile, operation);
    return operation;
  }
  private async load(profile: string, signal?: AbortSignal) {
    const epoch = this.epochs.get(profile) ?? 0;
    try {
      const response = await this.transport.request(profile, "/wham/usage", {
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(15_000),
        ]),
      });
      const value = Usage.parse(await readChatGptJson(response));
      const windows = (
        [
          ["primary", value.rate_limit?.primary_window],
          ["secondary", value.rate_limit?.secondary_window],
        ] as const
      ).flatMap(([id, window]) =>
        window
          ? [
              {
                id,
                remaining: 100 - window.used_percent,
                observedAt: Date.now(),
                seconds: window.limit_window_seconds,
                resetsAt: window.reset_at ? window.reset_at * 1000 : undefined,
              },
            ]
          : [],
      );
      signal?.throwIfAborted();
      if ((this.epochs.get(profile) ?? 0) !== epoch)
        return { revision: this.revision, windows: [] };
      return this.publish(profile, {
        windows,
        plan: value.plan_type,
        observedAt: Date.now(),
      });
    } catch {
      const previous = this.cache.get(profile);
      if ((this.epochs.get(profile) ?? 0) !== epoch)
        return { revision: this.revision, windows: [] };
      // A timestamp for failed observations prevents request storms; old values stay explicitly stale.
      if (signal?.aborted)
        return (
          previous ?? { revision: this.revision, windows: [], error: true }
        );
      return this.publish(profile, {
        ...previous,
        windows: previous?.windows ?? [],
        error: true,
        observedAt: Date.now(),
      });
    }
  }
  headers(profile: string, headers: Headers) {
    const previous = this.cache.get(profile);
    const windows = ["primary", "secondary"].flatMap((id) => {
      const used = headers.get(`x-codex-${id}-used-percent`);
      if (
        used === null ||
        !Number.isFinite(Number(used)) ||
        Number(used) < 0 ||
        Number(used) > 100
      )
        return [];
      const minutes = Number(headers.get(`x-codex-${id}-window-minutes`));
      const reset = Number(headers.get(`x-codex-${id}-reset-at`));
      return [
        {
          id,
          remaining: 100 - Number(used),
          observedAt: Date.now(),
          seconds: minutes > 0 ? minutes * 60 : undefined,
          resetsAt: reset > 0 ? reset * 1000 : undefined,
        },
      ];
    });
    if (windows.length)
      this.publish(profile, {
        windows: [
          ...windows,
          ...(previous?.windows ?? []).filter(
            (old) => !windows.some((current) => current.id === old.id),
          ),
        ],
        plan: previous?.plan,
        observedAt: Date.now(),
      });
  }
}
function windowLabel(window: UsageWindow) {
  if (window.seconds === 604800) return "Неделя";
  if (window.seconds && window.seconds % 3600 === 0)
    return `${window.seconds / 3600} ч`;
  if (window.seconds) return `${Math.round(window.seconds / 60)} мин`;
  return window.id === "primary" ? "Основной" : "Дополнительный";
}
function resetLabel(at?: number) {
  return at
    ? new Date(at).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "неизвестен";
}
export function usageUi(snapshot: UsageSnapshot): UiSnapshot {
  const stale =
    snapshot.error ||
    !snapshot.observedAt ||
    Date.now() - snapshot.observedAt > TTL * 2 ||
    snapshot.windows.some(
      (window) =>
        (window.observedAt !== undefined &&
          Date.now() - window.observedAt > TTL * 2) ||
        (window.resetsAt !== undefined && window.resetsAt <= Date.now()),
    );
  return {
    revision: snapshot.revision,
    state: snapshot.windows.length
      ? stale
        ? "stale"
        : "ready"
      : "unavailable",
    label: snapshot.plan
      ? `${snapshot.plan[0]?.toUpperCase() ?? ""}${snapshot.plan.slice(1)} · остаток`
      : "Остаток подписки",
    detail: snapshot.windows.length
      ? stale
        ? "Данные устарели"
        : undefined
      : "Лимиты недоступны",
    tone: stale
      ? "muted"
      : snapshot.windows.some((window) => window.remaining <= 10)
        ? "warning"
        : "muted",
    rows: snapshot.windows.flatMap((window) => {
      const percent = Math.floor(window.remaining);
      const filled = Math.round(window.remaining / 10);
      return [
        {
          id: window.id,
          label: windowLabel(window),
          value: `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${percent}%`,
          tone: percent <= 10 ? ("warning" as const) : ("accent" as const),
        },
        {
          id: `${window.id}-reset`,
          label: "Сброс",
          value: resetLabel(window.resetsAt),
          tone: "muted" as const,
        },
      ];
    }),
    action: { id: "details" },
  };
}
