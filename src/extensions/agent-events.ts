import { z } from "zod";
import type {
  AgentEventContext,
  AgentEventData,
  AgentEventHandler,
  AgentEventResult,
  AgentObservedEvent,
} from "../extension-sdk/agent-events.js";
import { cancelled } from "../runtime/errors.js";
import type { Disposable } from "./contracts.js";
import {
  abortable,
  extensionFailure,
  frozenClone,
  operationSignal,
} from "./lifecycle.js";

const jsonObject = z.record(z.string(), z.json());
const toolName = z.string().min(1).max(300);
const message = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z
          .object({
            type: z.literal("tool_use"),
            id: z.string().min(1),
            name: toolName,
            input: jsonObject,
          })
          .strict(),
        z
          .object({
            type: z.literal("tool_result"),
            toolUseId: z.string().min(1),
            content: z.string(),
            isError: z.boolean().optional(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
const request = z
  .object({
    model: z.string().min(1).max(300),
    system: z.string(),
    messages: z.array(message),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();
const response = z
  .object({
    message: message.refine((m) => {
      const ids = new Set<string>();
      return (
        m.role === "assistant" &&
        m.content.every((block) => {
          if (block.type === "tool_result") return false;
          if (block.type !== "tool_use") return true;
          if (ids.has(block.id)) return false;
          ids.add(block.id);
          return true;
        })
      );
    }, "Assistant responses must contain unique tool calls and no tool results."),
    stopReason: z.string().min(1),
    usage: z
      .object({
        contextInputTokens: z.number().nonnegative().optional(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheCreationTokens: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
// Hooks may return text/data, never attested artifacts, diffs, approval receipts or presentation authority.
const result = z
  .object({
    output: z.string(),
    rawOutput: z.string().optional(),
    isError: z.boolean().optional(),
    errorCode: z.string().max(120).optional(),
    preview: z.string().optional(),
    details: jsonObject.optional(),
  })
  .strict();
const call = z
  .object({ callId: z.string().min(1), name: toolName, input: jsonObject })
  .strict();
const inputs = {
  "prompt.submit": z.object({ text: z.string() }).strict(),
  "model.request": request,
  "model.response": response,
  "tool.call": call,
  "tool.result": z
    .object({ callId: z.string(), name: toolName, result: result })
    .strict(),
};
const outputs = {
  "prompt.submit": inputs["prompt.submit"],
  "model.request": z.union([
    z.object({ request }).strict(),
    z.object({ response }).strict(),
  ]),
  "model.response": response,
  "tool.call": z.union([
    z.object({ call }).strict(),
    z.object({ result }).strict(),
  ]),
  "tool.result": z.object({ result }).strict(),
};

export interface AgentEventPort {
  has(type: keyof AgentEventData): boolean;
  run<K extends keyof AgentEventData>(
    type: K,
    data: AgentEventData[K],
    context: Omit<AgentEventContext, "workspaceRoot" | "signal"> & {
      workspaceRoot?: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentEventResult[K]>;
  publish(event: AgentObservedEvent, signal?: AbortSignal): Promise<string[]>;
}
type Entry = {
  owner: string;
  type: keyof AgentEventData;
  handler: AgentEventHandler<keyof AgentEventData>;
};

/** Per-workspace middleware, ordered by activation/registration. Core consumes decisions before effects. */
export class AgentEventPipeline implements AgentEventPort, Disposable {
  private entries: Entry[] = [];
  private observers: {
    owner: string;
    handler: (event: Readonly<AgentObservedEvent>) => void | Promise<void>;
  }[] = [];
  private sealed = false;
  private closed = false;
  constructor(
    private workspaceRoot: string,
    private lifetime: AbortSignal,
  ) {}
  on<K extends keyof AgentEventData>(
    owner: string,
    type: K,
    handler: AgentEventHandler<K>,
  ): Disposable {
    if (
      this.closed ||
      this.sealed ||
      !(type in inputs) ||
      typeof handler !== "function"
    )
      throw Error("Agent event registrations are closed or invalid.");
    const entry = {
      owner,
      type,
      handler: handler as unknown as AgentEventHandler<keyof AgentEventData>,
    };
    this.entries.push(entry);
    return {
      dispose: () => {
        this.entries = this.entries.filter((e) => e !== entry);
      },
    };
  }
  observe(
    owner: string,
    handler: (event: Readonly<AgentObservedEvent>) => void | Promise<void>,
  ): Disposable {
    if (this.closed || this.sealed || typeof handler !== "function")
      throw Error("Agent event registrations are closed or invalid.");
    const entry = { owner, handler };
    this.observers.push(entry);
    return {
      dispose: () => {
        this.observers = this.observers.filter((e) => e !== entry);
      },
    };
  }
  has(type: keyof AgentEventData) {
    return !this.closed && this.entries.some((e) => e.type === type);
  }
  /** Reuse activated handlers for a child, with its real root and lifetime; no re-import or extra tools. */
  forWorkspace(workspaceRoot: string, lifetime: AbortSignal): AgentEventPort {
    return {
      has: (type) => !lifetime.aborted && this.has(type),
      run: (type, data, context, signal) =>
        this.run(
          type,
          data,
          { ...context, workspaceRoot },
          operationSignal(lifetime, signal),
        ),
      publish: (event, signal) =>
        lifetime.aborted
          ? Promise.resolve([])
          : this.publish(event, operationSignal(lifetime, signal)),
    };
  }
  async run<K extends keyof AgentEventData>(
    type: K,
    data: AgentEventData[K],
    context: Omit<AgentEventContext, "workspaceRoot" | "signal"> & {
      workspaceRoot?: string;
    },
    operation?: AbortSignal,
  ): Promise<AgentEventResult[K]> {
    if (this.closed) throw Error("Agent events are closed.");
    const invocation = new AbortController();
    const signal = AbortSignal.any([
      operationSignal(this.lifetime, operation),
      invocation.signal,
    ]);
    const parse = <T>(schema: z.ZodType, value: T): T => {
      const serialized = JSON.stringify(value);
      if (!serialized || Buffer.byteLength(serialized) > 4 * 1024 * 1024)
        throw Error("Agent event data is too large.");
      return frozenClone(schema.parse(JSON.parse(serialized)) as T);
    };
    const entries = this.entries.filter((e) => e.type === type);
    const dispatch = async (
      index: number,
      input: AgentEventData[K],
    ): Promise<AgentEventResult[K]> => {
      cancelled(signal);
      const entry = entries[index];
      if (!entry)
        return (
          type === "model.request"
            ? { request: input }
            : type === "tool.call"
              ? { call: input }
              : type === "tool.result"
                ? { result: (input as AgentEventData["tool.result"]).result }
                : input
        ) as AgentEventResult[K];
      let used = false,
        active = true,
        invalidContinuation = false,
        downstreamFailed = false,
        downstreamError: unknown;
      let pending: Promise<AgentEventResult[K]> | undefined;
      try {
        const event = Object.freeze({
          ...context,
          workspaceRoot: context.workspaceRoot ?? this.workspaceRoot,
          signal,
          type,
          data: parse(inputs[type], input),
        });
        const output = await abortable(
          () =>
            entry.handler(event, (replacement) => {
              if (used || !active) {
                invalidContinuation = true;
                throw Error(
                  "next() may be called only once during its handler.",
                );
              }
              used = true;
              pending = dispatch(
                index + 1,
                parse(inputs[type], replacement ?? input) as AgentEventData[K],
              );
              pending.catch((error) => {
                downstreamFailed = true;
                downstreamError = error;
              });
              return pending;
            }),
          signal,
        );
        active = false;
        // A handler cannot leave another handler running after its decision has been accepted.
        if (pending) await pending;
        if (invalidContinuation)
          throw Error("Invalid middleware continuation.");
        cancelled(signal);
        return parse(outputs[type], output) as AgentEventResult[K];
      } catch (error) {
        active = false;
        cancelled(signal);
        if (downstreamFailed && error === downstreamError) throw error;
        throw extensionFailure(
          "EXTENSION_HOOK_FAILED",
          `Расширение ${entry.owner}: ошибка обработчика ${type}.`,
          { extensionId: entry.owner, hookPoint: type },
          error,
        );
      }
    };
    try {
      return await dispatch(0, data);
    } finally {
      invocation.abort();
    }
  }
  async publish(event: AgentObservedEvent, operation?: AbortSignal) {
    if (this.closed || this.lifetime.aborted || !this.observers.length)
      return [];
    const failures: string[] = [];
    const signal = operationSignal(this.lifetime, operation);
    for (const entry of [...this.observers]) {
      cancelled(signal);
      try {
        await abortable(() => entry.handler(frozenClone(event)), signal);
      } catch {
        cancelled(signal);
        this.observers = this.observers.filter((e) => e !== entry);
        failures.push(
          `Расширение ${entry.owner}: наблюдатель событий отключён после ошибки.`,
        );
      }
    }
    return failures;
  }
  seal() {
    this.sealed = true;
  }
  dispose() {
    this.closed = true;
    this.entries = [];
    this.observers = [];
  }
}
