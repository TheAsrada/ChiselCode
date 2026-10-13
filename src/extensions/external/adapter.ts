import { Ajv } from "ajv";
import { z } from "zod";
import type * as Public from "../../extension-sdk/index.js";
import type {
  ModelRequestPort,
  ModelRequestResult,
} from "../../models/contracts.js";
import { cancelled, RuntimeError } from "../../runtime/errors.js";
import { editingHandlers } from "../../tools/editing/handlers.js";
import { fileHandlers } from "../../tools/local/files.js";
import { shellHandler } from "../../tools/local/shell.js";
import type { ToolContext, ToolHandler, ToolPlan } from "../../tools/types.js";
import type { ToolExecutionResult } from "../../types/domain.js";
import type {
  ChiselExtension,
  ExtensionContext,
  ExtensionToolContribution,
} from "../contracts.js";
import { frozenClone, operationSignal } from "../lifecycle.js";
import { createServiceToken } from "../services.js";
import type { ExtensionManifest } from "./manifest.js";

const tokenOwners = new WeakMap<object, symbol>();
const publicTools = new WeakMap<object, symbol>();
const nativeTools = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "delete_file",
  "apply_patch",
  "read_tool_result",
  "run_shell",
  "web_search",
  "web_fetch",
  "git_status",
  "git_diff",
  "git_log",
]);
const builtinTools = new Set([
  ...["list", "status", "create", "diff", "apply", "remove"].map(
    (name) => `ext:builtin.worktrees:${name}`,
  ),
  ...[
    "submit_readonly",
    "submit_coding",
    "list",
    "status",
    "result",
    "wait",
    "cancel",
    "prepare_worktree",
    "inspect_changes",
  ].map((name) => `ext:builtin.subagents:${name}`),
  ...["list", "status", "read_output", "wait", "stop", "recover"].map(
    (name) => `ext:builtin.background:${name}`,
  ),
  ...[
    "status",
    "diagnostics",
    "definition",
    "references",
    "symbols",
    "restart",
  ].map((name) => `ext:builtin.lsp:${name}`),
]);
function unavailable(message = "Capability расширения недоступна."): never {
  throw new RuntimeError("PERMISSION_DENIED", message);
}
function assertLive(signal: AbortSignal) {
  cancelled(signal);
}
function publicGuard(
  snapshot: import("../contracts.js").ToolGuardSnapshot,
): Public.GuardSnapshot {
  return Object.freeze({
    workspaceRoot: snapshot.workspaceRoot,
    sessionId: snapshot.sessionId,
    callId: snapshot.callId,
    mode: snapshot.mode,
    signal: snapshot.signal,
    preview: snapshot.preview,
    resources: snapshot.resources,
    ...(snapshot.command ? { command: snapshot.command } : {}),
    tool: Object.freeze({
      name: snapshot.tool.name,
      effect: snapshot.tool.effect,
    }),
    input: snapshot.input as Public.JsonObject,
  });
}
function schemaValidator(schema: Public.JsonObject) {
  if (
    Buffer.byteLength(JSON.stringify(schema)) > 65536 ||
    schema.type !== "object"
  )
    throw new Error("Требуется bounded object JSON Schema.");
  const keywords = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "description",
    "title",
    "default",
  ]);
  function check(value: Public.Json, depth: number) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      depth > 16
    )
      throw new Error("Неподдерживаемый JSON Schema dialect.");
    for (const [key, item] of Object.entries(value)) {
      if (!keywords.has(key))
        throw new Error(`Неподдерживаемый JSON Schema keyword: ${key}`);
      if (key === "properties") {
        if (!item || typeof item !== "object" || Array.isArray(item))
          throw new Error("Некорректные properties.");
        for (const child of Object.values(item)) check(child, depth + 1);
      } else if (
        ["items", "additionalProperties"].includes(key) &&
        typeof item === "object"
      )
        check(item, depth + 1);
      else if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(item) || item.length > 32)
          throw new Error("Некорректная schema composition.");
        for (const child of item) check(child, depth + 1);
      }
    }
  }
  check(schema, 0);
  return new Ajv({
    strict: true,
    validateFormats: false,
    allErrors: false,
    logger: false,
  }).compile(schema);
}
export function createHostSdk(manifest: ExtensionManifest): Public.HostSdk {
  const owner = Symbol(manifest.id);
  return Object.freeze({
    apiVersion: 1 as const,
    chiselVersion: HOST_VERSION,
    defineTool<Input>(
      definition: Public.ToolDefinition<Input>,
    ): Public.ToolDefinition<Input> {
      if (
        typeof definition.prepare !== "function" ||
        typeof definition.execute !== "function"
      )
        throw new Error("Tool требует prepare/execute.");
      const schema = frozenClone(definition.inputSchema);
      schemaValidator(schema);
      const captured = Object.freeze({
        ...definition,
        inputSchema: schema,
        prepare: definition.prepare.bind(definition),
        execute: definition.execute.bind(definition),
      });
      publicTools.set(captured, owner);
      return captured;
    },
    createServiceToken<T>(diagnosticId: string): Public.ServiceToken<T> {
      const token = createServiceToken<T>(diagnosticId);
      tokenOwners.set(token, owner);
      return token as unknown as Public.ServiceToken<T>;
    },
  });
}

import { VERSION as HOST_VERSION } from "../../version.js";

interface CapturedPlan {
  handler: ToolHandler;
  plan: ToolPlan;
  public: Public.EffectPlan;
  root: string;
  session: string;
  invocation?: string;
}
function invocation(
  context: ToolContext,
  signal: AbortSignal,
): Public.Invocation {
  return Object.freeze({
    workspaceRoot: context.workspace.root,
    sessionId: context.session.id,
    invocationId: context.invocationId ?? "",
    mode: context.mode ?? context.session.mode ?? "build",
    signal,
  });
}
function adaptTool(
  definition: Public.ToolDefinition<unknown>,
  lifetime: AbortSignal,
): ExtensionToolContribution {
  const metadata = z
    .object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      description: z.string().min(1).max(2000),
      effect: z.enum(["read", "workspace_write", "process"]),
      timeoutMs: z.number().int().positive().max(610000).optional(),
    })
    .parse(definition);
  const validate = schemaValidator(definition.inputSchema),
    prepare = definition.prepare.bind(definition),
    execute = definition.execute.bind(definition);
  const plans = new WeakMap<object, CapturedPlan>();
  const read = fileHandlers().find((tool) => tool.spec.name === "read_file")!,
    write = editingHandlers().find((tool) => tool.spec.name === "write_file")!,
    shell = shellHandler();
  return {
    spec: {
      ...metadata,
      inputSchema: definition.inputSchema,
      permission:
        metadata.effect === "read"
          ? "read"
          : metadata.effect === "workspace_write"
            ? "edit"
            : "shell",
      parallelSafe: metadata.effect === "read",
      ...(definition.chat ? { chat: definition.chat } : {}),
    },
    parse(input) {
      if (
        Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024 ||
        !validate(input)
      )
        throw new RuntimeError(
          "INVALID_TOOL_INPUT",
          "Аргументы не соответствуют JSON Schema расширения.",
        );
      return frozenClone(input);
    },
    async prepare(context, input) {
      const signal = operationSignal(lifetime, context.signal);
      assertLive(signal);
      const ownPlans = new Set<object>();
      let open = true;
      const prepareEffect = async (
        handler: ToolHandler,
        input: Public.JsonObject,
      ): Promise<Public.EffectPlan> => {
        assertLive(signal);
        if (!open || handler.spec.effect !== metadata.effect)
          unavailable("Эффект не соответствует объявленному tool.");
        // Core preparation uses the existing workspace/editing machinery under the outer read lease.
        const coreContext =
          handler === shell ? { ...context, background: undefined } : context;
        const plan = await handler.prepare(coreContext, handler.parse(input));
        assertLive(signal);
        const display = frozenClone({
          preview: plan.preview,
          resources: plan.resources,
        }) as unknown as Public.EffectPlan;
        plans.set(display, {
          handler,
          plan,
          public: display,
          root: context.workspace.root,
          session: context.session.id,
          invocation: context.invocationId,
        });
        ownPlans.add(display);
        return display;
      };
      try {
        const publicContext: Public.ToolPrepareContext = Object.freeze({
          ...invocation(context, signal),
          plan: Object.freeze({
            readText: (
              path: string,
              options: { offset?: number; limit?: number } = {},
            ) => prepareEffect(read, { path, ...options }),
            writeText: (path: string, content: string) =>
              prepareEffect(write, { path, content }),
            shell: (
              command: string,
              options: { cwd?: string; timeout?: number } = {},
            ) => prepareEffect(shell, { command, ...options }),
          }),
        });
        const publicPlan = await prepare(publicContext, input);
        assertLive(signal);
        if (!publicPlan || !ownPlans.has(publicPlan))
          unavailable("prepare должен вернуть план текущего invocation.");
        const captured = plans.get(publicPlan)!;
        return { ...captured.plan, data: captured };
      } finally {
        open = false;
      }
    },
    async execute(context, plan) {
      const signal = operationSignal(lifetime, context.signal);
      assertLive(signal);
      const captured = plan.data as CapturedPlan;
      if (
        !captured ||
        plans.get(captured.public) !== captured ||
        captured.root !== context.workspace.root ||
        captured.session !== context.session.id ||
        captured.invocation !== context.invocationId
      )
        unavailable("План не принадлежит текущему invocation.");
      let open = true,
        run: Promise<Public.ToolResult> | undefined;
      const effects = Object.freeze({
        run: () => {
          assertLive(signal);
          if (!open) unavailable();
          run ??= captured.handler
            .execute(
              captured.handler === shell
                ? {
                    ...context,
                    signal,
                    background: undefined,
                    backgroundExecution: undefined,
                  }
                : { ...context, signal },
              captured.plan,
            )
            .then((result) =>
              publicResult(context.sanitizeResult?.(result) ?? result),
            );
          return run;
        },
      });
      try {
        const result = await execute(
          Object.freeze({ ...invocation(context, signal), effects }),
          captured.public,
        );
        // A started effect must settle before the outer executor releases its lease, including callback failure.
        if (run) await run;
        assertLive(signal);
        return result as ToolExecutionResult;
      } finally {
        open = false;
        if (run) await run.catch(() => {});
        plans.delete(captured.public);
      }
    },
  };
}
function publicResult(result: ToolExecutionResult): Public.ToolResult {
  return frozenClone({
    output: result.output,
    ...(result.rawOutput ? { rawOutput: result.rawOutput } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.details ? { details: result.details } : {}),
    ...(result.preview ? { preview: result.preview } : {}),
    ...(result.fileDiff ? { fileDiff: result.fileDiff } : {}),
    ...(result.diffs ? { diffs: result.diffs } : {}),
    ...(result.artifact ? { artifact: result.artifact } : {}),
    ...(result.requiresApproval !== undefined
      ? { requiresApproval: result.requiresApproval }
      : {}),
  }) as Public.ToolResult;
}
function publicModel(
  port: ModelRequestPort,
  signal: AbortSignal,
  results: WeakMap<object, ModelRequestResult>,
): Public.ModelPort {
  const display = (result: ModelRequestResult): Public.ModelResult => {
    const value = frozenClone({
      operationId: result.operationId,
      status: result.status,
      text: result.text,
      usageSource: result.usageSource,
      knownCost: result.knownCost,
      attempts: result.attempts,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    results.set(value, result);
    return value;
  };
  return Object.freeze({
    request: async (
      input: Public.ModelRequestInput,
      observer?: (event: Readonly<Public.ModelEvent>) => void,
    ) => {
      assertLive(signal);
      return display(
        await port.request(
          frozenClone(input),
          observer
            ? (event) => {
                assertLive(signal);
                observer(
                  Object.freeze(
                    event.type === "terminal"
                      ? {
                          type: "terminal",
                          operationId: event.operationId,
                          result: display(event.result),
                        }
                      : event.type === "text"
                        ? {
                            type: "text",
                            operationId: event.operationId,
                            text: event.text,
                          }
                        : {
                            type: "status",
                            operationId: event.operationId,
                            status: event.status,
                          },
                  ),
                );
              }
            : undefined,
        ),
      );
    },
  });
}
export function adaptDefinition(
  definition: Public.ExtensionDefinition,
  manifest: ExtensionManifest,
  sdk: Public.HostSdk,
): ChiselExtension {
  if (
    !definition ||
    definition.id !== manifest.id ||
    definition.version !== manifest.version ||
    definition.apiVersion !== 1 ||
    definition.entry !== manifest.entry ||
    typeof definition.activate !== "function"
  )
    throw new Error("Factory definition не совпадает с manifest.");
  const activate = definition.activate.bind(definition);
  // Helpers are owned by this injected SDK instance, not diagnostic token strings.
  const probe = sdk.createServiceToken<unknown>("sdk-owner"),
    owner = tokenOwners.get(probe)!;
  return Object.freeze({
    id: manifest.id,
    themes: definition.themes ? frozenClone(definition.themes) : undefined,
    activate: (core: ExtensionContext) => {
      const alive = () => assertLive(core.signal);
      const token = <T>(value: Public.ServiceToken<T>) => {
        alive();
        if (tokenOwners.get(value) !== owner)
          unavailable("Service token принадлежит другому SDK.");
        return value as unknown as import("../services.js").ServiceToken<T>;
      };
      const context: Public.ActivationContext = Object.freeze({
        workspaceRoot: core.workspaceRoot,
        signal: core.signal,
        tools: Object.freeze({
          register<Input>(tool: Public.ToolDefinition<Input>) {
            alive();
            if (publicTools.get(tool) !== owner)
              unavailable("Tool должен быть создан injected sdk.defineTool.");
            core.tools.register(
              adaptTool(tool as Public.ToolDefinition<unknown>, core.signal),
            );
          },
        }),
        services: Object.freeze({
          provide<T>(value: Public.ServiceToken<T>, service: T) {
            core.services.provide(token(value), service);
          },
          get<T>(value: Public.ServiceToken<T>) {
            return core.services.get(token(value));
          },
          lookup<T>(value: Public.ServiceToken<T>) {
            return core.services.lookup(token(value));
          },
        }),
        commands: Object.freeze({
          register<Input>(command: Public.Command<Input>) {
            alive();
            const executionPolicy = command.executionPolicy ?? "foreground";
            if ("executeControl" in command || "controlActions" in command)
              unavailable("Busy control — private core capability.");
            const execute = command.execute.bind(command),
              results = new WeakMap<object, ModelRequestResult>();
            core.commands.register({
              name: command.name,
              description: command.description,
              ...(command.usage ? { usage: command.usage } : {}),
              ...(command.chat ? { chat: command.chat } : {}),
              parse: command.parse.bind(command),
              executionPolicy,
              execute: async (
                internal:
                  | import("../contracts.js").ExtensionCommandInvocation
                  | import("../contracts.js").SideQueryCommandInvocation,
                input: Input,
              ) => {
                const signal = operationSignal(core.signal, internal.signal);
                alive();
                assertLive(signal);
                const tools =
                  "tools" in internal
                    ? Object.freeze({
                        execute: async (
                          name: string,
                          args: Public.JsonObject,
                        ) => {
                          assertLive(signal);
                          const parts = name.split(":");
                          if (
                            !(
                              nativeTools.has(name) ||
                              builtinTools.has(name) ||
                              (parts.length === 3 &&
                                parts[0] === "ext" &&
                                parts[1] === manifest.id)
                            )
                          )
                            unavailable(
                              "Инструмент не входит в разрешённый invocation port.",
                            );
                          return publicResult(
                            await internal.tools.execute(
                              name,
                              frozenClone(args),
                            ),
                          );
                        },
                      })
                    : undefined;
                const publicContext = Object.freeze({
                  workspaceRoot: internal.workspaceRoot,
                  sessionId: internal.sessionId,
                  invocationId: internal.invocationId,
                  mode: internal.mode,
                  signal,
                  model: publicModel(internal.model, signal, results),
                  ...(tools ? { tools } : {}),
                });
                const result = await execute(
                  publicContext as Public.CommandContext,
                  input,
                );
                assertLive(signal);
                if (executionPolicy === "side_query") {
                  const actual = results.get(result);
                  if (!actual)
                    unavailable(
                      "side_query возвращает результат своего model port.",
                    );
                  return actual;
                }
                return result as ToolExecutionResult;
              },
            } as import("../contracts.js").ExtensionCommandContribution<Input>);
          },
        }),
        chat: Object.freeze({
          register(view: {
            id: string;
            render(data: unknown): Public.ChatPresentation | undefined;
          }) {
            alive();
            core.chat.register({ id: view.id, render: view.render.bind(view) });
          },
        }),
        ui: Object.freeze({
          register(contribution: Public.UiContribution) {
            alive();
            if (
              contribution.actions?.some(
                (action) => !(action.type === "view" || action.type === "tool"),
              )
            )
              unavailable("Недопустимое external UI action.");
            core.ui.register(contribution);
          },
          registerView(view: Public.UiDetailsView) {
            alive();
            if (
              view.actions?.some(
                (action) => !(action.type === "view" || action.type === "tool"),
              )
            )
              unavailable("Недопустимое external UI action.");
            core.ui.registerView(view);
          },
        }),
        guards: Object.freeze({
          afterPrepare(guard: Public.Guard) {
            alive();
            core.guards.afterPrepare((snapshot) =>
              guard(publicGuard(snapshot)),
            );
          },
          beforeExecute(guard: Public.Guard) {
            alive();
            core.guards.beforeExecute((snapshot) =>
              guard(publicGuard(snapshot)),
            );
          },
        }),
        contextProviders: Object.freeze({
          register: (
            provider: Parameters<
              Public.ActivationContext["contextProviders"]["register"]
            >[0],
          ) => {
            alive();
            core.contextProviders.register(provider);
          },
        }),
        add(disposable: Public.Disposable) {
          alive();
          core.add(disposable);
        },
      });
      return activate(context);
    },
  });
}
