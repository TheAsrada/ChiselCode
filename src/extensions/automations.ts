import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AutomationDefinition } from "../extension-sdk/automations.js";
import { cancelled } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";
import type { ExtensionActivation } from "./activation.js";
import { safeExtensionText } from "./external/loader.js";
import { frozenClone } from "./lifecycle.js";
import {
  currentProcessIdentity,
  identityState,
} from "./packages/process-identity.js";
import {
  atomicPackageJson,
  boundedJson,
  packageDirectory,
} from "./packages/storage.js";

const id = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const schedule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: z.iso.datetime() }),
  z.strictObject({
    kind: z.literal("interval"),
    firstAt: z.iso.datetime(),
    everyMs: z
      .number()
      .int()
      .min(1000)
      .max(365 * 86400000),
  }),
]);
const statuses = z.enum([
  "accepted",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const runSchema = z.strictObject({
  id: z.string(),
  at: z.number(),
  status: statuses,
  result: z.string().optional(),
  process: z
    .strictObject({
      pid: z.number().int(),
      host: z.string(),
      start: z.string().optional(),
    })
    .optional(),
});
const stateSchema = z.strictObject({
  schedule,
  paused: z.boolean(),
  next: z.number().int().nullable(),
  last: runSchema.optional(),
  history: z.array(runSchema).max(16).default([]),
});
type State = z.infer<typeof stateSchema>;

type RunResult = {
  status: "succeeded" | "failed" | "cancelled";
  result?: string;
};
export interface AutomationDispatch {
  reserve(): Promise<(() => Promise<void>) | undefined>;
  execute(input: {
    owner: ExtensionActivation;
    definition: AutomationDefinition;
    runId: string;
    signal: AbortSignal;
  }): Promise<RunResult>;
}

export interface AutomationStatus {
  id: string;
  paused: boolean;
  nextAt?: string;
  last?: { at: string; status: z.infer<typeof statuses>; result?: string };
}

export function captureAutomation(
  owner: string,
  input: AutomationDefinition,
): AutomationDefinition {
  id.parse(input.id);
  const timing = schedule.parse(input.schedule);
  const tool = z
    .strictObject({
      name: z.string().max(200),
      input: z.record(z.string(), z.json()),
    })
    .parse(input.tool);
  if (
    !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) &&
    !(
      tool.name.startsWith(`ext:${owner}:`) &&
      id.safeParse(tool.name.split(":")[2]).success &&
      tool.name.split(":").length === 3
    )
  )
    throw new Error(
      "Автоматизация принимает штатный инструмент или инструмент своего расширения.",
    );
  if (Buffer.byteLength(JSON.stringify(tool.input)) > 32768)
    throw new Error("Входные данные автоматизации больше 32 KiB.");
  return frozenClone({
    id: input.id,
    schedule: timing,
    tool,
  }) as AutomationDefinition;
}

export class ExtensionAutomations {
  private readonly tasks = new Map<
    string,
    {
      owner: ExtensionActivation;
      definition: AutomationDefinition;
      check: <T>(claim: () => Promise<T>) => Promise<T | undefined>;
      status?: AutomationStatus;
      running?: AbortController;
      busy?: boolean;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly dispatch?: AutomationDispatch,
    private readonly changed: () => void = () => {},
  ) {}

  publish(
    owner: ExtensionActivation,
    definitions: readonly AutomationDefinition[],
    check: <T>(claim: () => Promise<T>) => Promise<T | undefined>,
  ) {
    if (!this.dispatch) return;
    for (const [key, task] of this.tasks)
      if (task.owner.extensionId === owner.extensionId) this.tasks.delete(key);
    if (!definitions.length) return;
    for (const definition of definitions)
      this.tasks.set(this.key(owner.extensionId, definition.id), {
        owner,
        definition,
        check,
      });
    this.timer ??= setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  revoke(owner: ExtensionActivation) {
    for (const task of this.tasks.values())
      if (task.owner === owner) {
        task.running?.abort();
        // Keep the last projection visible while this workspace is open.
        if (task.status) task.status = { ...task.status, nextAt: undefined };
      }
    if ([...this.tasks.values()].every((task) => task.owner.signal.aborted)) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  list(extensionId: string): AutomationStatus[] {
    return [...this.tasks.values()].flatMap(({ owner, status }) =>
      owner.extensionId === extensionId && status
        ? [structuredClone(status)]
        : [],
    );
  }

  async pause(extensionId: string, taskId: string, paused: boolean) {
    const task = this.tasks.get(this.key(extensionId, taskId));
    if (!task || task.owner.signal.aborted)
      throw new Error("Автоматизация недоступна.");
    await this.edit(task.owner, task.definition, async (state, save) => {
      state.paused = paused;
      await save();
      this.project(task, state);
    });
    if (paused) task.running?.abort();
    else this.tick();
  }

  private key(owner: string, task: string) {
    return JSON.stringify([owner, task]);
  }

  private async edit<T>(
    owner: ExtensionActivation,
    definition: AutomationDefinition,
    change: (state: State, save: () => Promise<void>) => Promise<T>,
  ) {
    const key = createHash("sha256")
      .update(
        JSON.stringify([owner.workspaceRoot, owner.extensionId, definition.id]),
      )
      .digest("hex");
    const file = join(await packageDirectory(".automations"), key + ".json");
    return withLock(file, async (assertOwned) => {
      let state: State;
      try {
        state = stateSchema.parse(await boundedJson(file, 16384));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const timing = definition.schedule;
        state = {
          schedule: timing,
          paused: false,
          history: [],
          next: Date.parse(timing.kind === "once" ? timing.at : timing.firstAt),
        };
        await atomicPackageJson(file, state, assertOwned);
      }
      if (
        JSON.stringify(state.schedule) !== JSON.stringify(definition.schedule)
      )
        throw new Error(
          "Для изменения расписания укажите новый ID автоматизации.",
        );
      return change(state, () => atomicPackageJson(file, state, assertOwned));
    });
  }

  private project(
    task: { definition: AutomationDefinition; status?: AutomationStatus },
    state: State,
  ) {
    const status: AutomationStatus = {
      id: task.definition.id,
      paused: state.paused,
      ...(!state.paused && state.next !== null
        ? { nextAt: new Date(state.next).toISOString() }
        : {}),
      ...(state.last
        ? {
            last: {
              at: new Date(state.last.at).toISOString(),
              status: state.last.status,
              result: state.last.result,
            },
          }
        : {}),
    };
    if (JSON.stringify(task.status) !== JSON.stringify(status)) {
      task.status = status;
      this.changed();
    }
  }

  private tick() {
    for (const task of this.tasks.values()) {
      if (task.busy || !task.owner.published || task.owner.signal.aborted)
        continue;
      task.busy = true;
      const run = new AbortController();
      task.running = run;
      const dispatch = this.dispatch!;
      let release: (() => Promise<void>) | undefined;
      void task.owner
        .run(async () => {
          const { definition, owner } = task;
          const claim = await this.edit(
            owner,
            definition,
            async (state, save) => {
              this.project(task, state);
              if (state.last?.status === "accepted") {
                if (
                  !state.last.process ||
                  (await identityState(state.last.process)) !== "dead"
                )
                  return;
                state.last = {
                  ...state.last,
                  status: "interrupted",
                  process: undefined,
                };
                await save();
                this.project(task, state);
              }
              const now = Date.now();
              if (state.paused || state.next === null || now < state.next)
                return;
              release = await dispatch.reserve();
              if (!release) return;
              return task.check(async () => {
                cancelled(AbortSignal.any([owner.signal, run.signal]));
                const timing = state.schedule;
                // Coalesce missed interval occurrences into the latest due slot.
                const at =
                  timing.kind === "once"
                    ? state.next!
                    : state.next! +
                      Math.floor((now - state.next!) / timing.everyMs) *
                        timing.everyMs;
                const runId = createHash("sha256")
                  .update(
                    JSON.stringify([
                      owner.workspaceRoot,
                      owner.extensionId,
                      definition.id,
                      at,
                    ]),
                  )
                  .digest("hex");
                if (state.last)
                  state.history = [...state.history.slice(-15), state.last];
                state.last = {
                  id: runId,
                  at,
                  status: "accepted",
                  process: await currentProcessIdentity(),
                };
                state.next =
                  timing.kind === "once" ? null : at + timing.everyMs;
                cancelled(AbortSignal.any([owner.signal, run.signal]));
                await save();
                this.project(task, state);
                return runId;
              });
            },
          );
          if (!claim) return;
          const signal = AbortSignal.any([run.signal, owner.signal]);
          let outcome: RunResult;
          try {
            cancelled(signal);
            outcome = await dispatch.execute({
              owner,
              definition,
              runId: claim,
              signal,
            });
          } catch (error) {
            outcome = {
              status: signal.aborted ? "cancelled" : "failed",
              result: safeExtensionText(
                error instanceof Error ? error.message : String(error),
              ),
            };
          }
          await this.edit(owner, definition, async (state, save) => {
            if (state.last?.id !== claim) return;
            state.last = {
              id: claim,
              at: state.last.at,
              status: outcome.status,
              result: outcome.result?.slice(0, 240),
            };
            await save();
            this.project(task, state);
            if (owner.signal.aborted)
              task.status = { ...task.status!, nextAt: undefined };
          });
        })
        .catch((error: unknown) => {
          if (!task.owner.signal.aborted)
            task.status = {
              id: task.definition.id,
              paused: task.status?.paused ?? false,
              last: {
                at: new Date().toISOString(),
                status: "failed",
                result: safeExtensionText(String(error)),
              },
            };
        })
        .finally(async () => {
          try {
            await release?.();
          } finally {
            task.busy = false;
            task.running = undefined;
          }
        })
        .catch(() => {});
    }
  }
}
