import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ToolCatalog } from "../tools/catalog.js";
import { isReadEffect, TOOL_EFFECTS } from "../tools/effects.js";
import type {
  ToolContext,
  ToolHandler,
  ToolProvider,
  ToolSpec,
} from "../tools/types.js";
import type { Disposable, ExtensionToolContribution } from "./contracts.js";
import type { WorkspaceExtensionScope } from "./host.js";
import {
  ExtensionLifecycleError,
  frozenClone,
  operationSignal,
} from "./lifecycle.js";

const metadata = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().trim().min(1),
  effect: z.enum(TOOL_EFFECTS),
  permission: z.string().trim().min(1),
  parallelSafe: z.boolean(),
  workspaceAccess: z.enum(["read", "write", "none"]).optional(),
  pinned: z.boolean().optional(),
  timeoutMs: z.number().positive().finite().optional(),
  outputPolicy: z
    .object({ maxInlineTokens: z.number().positive().finite().optional() })
    .strict()
    .optional(),
});

/** Workspace bookkeeping only. Selection, lookup and execution stay in ToolCatalog. */
export class ExtensionToolContributions implements ToolProvider {
  private readonly handlers = new Map<string, ToolHandler>();
  private sealed = false;
  private closed = false;
  constructor(
    private readonly lifetime: AbortSignal,
    private readonly assertAvailable: () => void,
  ) {}
  register(extensionId: string, tool: ExtensionToolContribution): Disposable {
    if (this.sealed || this.closed)
      throw new ExtensionLifecycleError(
        `Extension ${extensionId} tool registrations are closed.`,
        extensionId,
      );
    let handler: ToolHandler;
    try {
      if (
        !tool?.spec ||
        "source" in tool.spec ||
        "guidance" in tool.spec ||
        "permissions" in tool ||
        "rememberApproval" in tool
      )
        throw new Error(
          "Owner, guidance and MCP approval hooks are core-owned.",
        );
      const spec = metadata.parse(tool.spec);
      if (isReadEffect(spec.effect) && spec.workspaceAccess === "write")
        throw new Error("Read effects cannot request workspace write access.");
      const schema = z.json().parse(tool.spec.inputSchema);
      if (
        !schema ||
        Array.isArray(schema) ||
        typeof schema !== "object" ||
        schema.type !== "object"
      )
        throw new Error("An object JSON schema is required.");
      const SchemaValidator =
        schema.$schema === "https://json-schema.org/draft/2020-12/schema"
          ? Ajv2020
          : Ajv;
      if (
        !new SchemaValidator({
          strict: false,
          validateFormats: false,
          logger: false,
        }).validateSchema(schema)
      )
        throw new Error("Invalid object JSON schema.");
      if (
        [tool.parse, tool.prepare, tool.execute].some(
          (fn) => typeof fn !== "function",
        )
      )
        throw new Error("parse, prepare and execute must be functions.");
      const name = `ext:${extensionId}:${spec.name}`;
      if (this.handlers.has(name))
        throw new ExtensionLifecycleError(
          `Duplicate tool ${name} from extension ${extensionId}.`,
          extensionId,
        );
      const parse = tool.parse.bind(tool);
      const prepare = tool.prepare.bind(tool);
      const execute = tool.execute.bind(tool);
      const context = (caller: ToolContext): ToolContext => {
        const signal = operationSignal(this.lifetime, caller.signal);
        cancelled(signal);
        this.assertAvailable();
        return { ...caller, signal };
      };
      handler = Object.freeze({
        spec: frozenClone({
          ...spec,
          name,
          inputSchema: schema,
          source: { type: "extension", extensionId, originalName: spec.name },
        }) as ToolSpec,
        lifetimeSignal: this.lifetime,
        parse: (input) => {
          cancelled(this.lifetime);
          this.assertAvailable();
          return parse(input);
        },
        prepare: async (caller, input) => {
          const invocation = context(caller);
          const plan = await prepare(invocation, input);
          cancelled(invocation.signal);
          if (plan.approval !== undefined)
            throw new RuntimeError(
              "INVALID_TOOL_INPUT",
              "Extension tools cannot supply MCP approval metadata.",
            );
          return plan;
        },
        execute: async (caller, plan) => {
          const invocation = context(caller);
          // Cooperative cancellation only: never release a mutation lease before it settles.
          const result = await execute(invocation, plan);
          cancelled(invocation.signal);
          return result;
        },
      } satisfies ToolHandler);
    } catch (cause) {
      if (cause instanceof ExtensionLifecycleError) throw cause;
      throw new ExtensionLifecycleError(
        `Invalid tool contribution from extension ${extensionId}.`,
        extensionId,
        cause,
      );
    }
    this.handlers.set(handler.spec.name, handler);
    let removed = false;
    return {
      dispose: () => {
        if (removed) return;
        removed = true;
        this.handlers.delete(handler.spec.name);
      },
    };
  }
  seal(): void {
    this.sealed = true;
  }
  dispose(): void {
    this.closed = true;
    this.handlers.clear();
  }
  private available(): void {
    if (this.closed || !this.sealed)
      throw new ExtensionLifecycleError("Extension tools are not available.");
    this.assertAvailable();
  }
  async listTools(): Promise<ToolSpec[]> {
    this.available();
    return [...this.handlers.values()].map((handler) => handler.spec);
  }
  async getHandler(name: string): Promise<ToolHandler> {
    this.available();
    const handler = this.handlers.get(name);
    if (!handler)
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        `Unknown extension tool: ${name}`,
      );
    return handler;
  }
}

/** One prompt owns the binding; it never owns the borrowed workspace/services. */
export async function attachExtensionTools(
  scope: WorkspaceExtensionScope,
  catalog: ToolCatalog,
): Promise<Disposable> {
  scope.assertUsable();
  if (catalog.hasProvider("extensions"))
    throw new ExtensionLifecycleError(
      "Extension tools are already attached to this catalog.",
    );
  let published = false;
  try {
    await catalog.replaceProvider("extensions", scope.tools, {
      requireNew: true,
    });
    published = true;
    scope.assertUsable();
  } catch (cause) {
    if (published) await catalog.replaceProvider("extensions");
    throw new ExtensionLifecycleError(
      "Failed to attach extension tools. " +
        (cause instanceof Error ? cause.message : "Provider snapshot failed."),
      cause &&
        typeof cause === "object" &&
        "extensionId" in cause &&
        typeof cause.extensionId === "string"
        ? cause.extensionId
        : undefined,
      cause,
    );
  }
  let disposal: Promise<void> | undefined;
  return {
    dispose: () => (disposal ??= catalog.replaceProvider("extensions")),
  };
}
