import { z } from "zod";
import { BUILTIN_COMMAND_NAMES } from "../commands/slash.js";
import type { ModelRequestResult } from "../models/contracts.js";
import { cancelled } from "../runtime/errors.js";
import type { ToolExecutionResult } from "../types/domain.js";
import type {
  Disposable,
  ExtensionCommandContribution,
  ExtensionCommandDescriptor,
  ExtensionCommandInvocation,
  SideQueryCommandInvocation,
  SubagentControlInvocation,
} from "./contracts.js";
import { ExtensionLifecycleError, frozenClone } from "./lifecycle.js";

// Single-line terminal metadata, not instructions or UI controls.
export const COMMAND_DESCRIPTION_LIMIT = 240;
export const COMMAND_USAGE_LIMIT = 160;
const plainText = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Metadata cannot control the terminal or create extra lines.
    .regex(/^[^\x00-\x1f\x7f-\x9f\u2028\u2029]+$/);
const registration = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    description: plainText(COMMAND_DESCRIPTION_LIMIT),
    usage: plainText(COMMAND_USAGE_LIMIT).optional(),
    executionPolicy: z.enum(["foreground", "side_query"]).default("foreground"),
    controlActions: z
      .array(z.string().regex(/^[a-z_]+$/))
      .max(8)
      .optional(),
    executeControl: z
      .custom<(context: SubagentControlInvocation, input: unknown) => unknown>(
        (value) => typeof value === "function",
      )
      .optional(),
    parse: z.custom<(...args: never[]) => unknown>(
      (value) => typeof value === "function",
    ),
    execute: z.custom<(...args: never[]) => unknown>(
      (value) => typeof value === "function",
    ),
  })
  .strict();

export interface RegisteredExtensionCommand extends ExtensionCommandDescriptor {
  readonly executionPolicy: "foreground" | "side_query";
  executeControl?(
    context: SubagentControlInvocation,
    input: unknown,
  ): Promise<ToolExecutionResult>;
  parse(args: string): unknown;
  execute(
    context: ExtensionCommandInvocation | SideQueryCommandInvocation,
    input: unknown,
  ): Promise<ToolExecutionResult | ModelRequestResult>;
}

/** Staged workspace ownership only; the composed slash projection resolves names. */
export class ExtensionCommandContributions {
  private readonly commands = new Map<string, RegisteredExtensionCommand>();
  private sealed = false;
  private closed = false;
  constructor(
    private readonly assertAvailable: () => void,
    private readonly lifetime: AbortSignal,
  ) {}
  register<T>(
    extensionId: string,
    command: ExtensionCommandContribution<T>,
  ): Disposable {
    if (this.sealed || this.closed)
      throw new ExtensionLifecycleError(
        `Extension ${extensionId} command registrations are closed.`,
        extensionId,
      );
    let stored: RegisteredExtensionCommand;
    try {
      const metadata = registration.parse(command);
      if (
        !!metadata.controlActions !== !!metadata.executeControl ||
        (metadata.controlActions && metadata.executionPolicy !== "foreground")
      )
        throw new Error("Invalid command control policy");
      const executeControl = command.executeControl?.bind(command);
      if (BUILTIN_COMMAND_NAMES.has(`/${metadata.name}`))
        throw new ExtensionLifecycleError(
          `Command /${metadata.name} from extension ${extensionId} conflicts with a built-in command.`,
          extensionId,
        );
      const prior = this.commands.get(metadata.name);
      if (prior)
        throw new ExtensionLifecycleError(
          `Duplicate command /${metadata.name} from extension ${extensionId}; owned by ${prior.source.extensionId}.`,
          extensionId,
        );
      const parse = command.parse.bind(command);
      // The discriminator selects which restricted context core supplies. Callable
      // references and policy are captured together, never read from caller again.
      const execute = command.execute.bind(command) as (
        context: ExtensionCommandInvocation | SideQueryCommandInvocation,
        input: T,
      ) =>
        | ToolExecutionResult
        | ModelRequestResult
        | Promise<ToolExecutionResult | ModelRequestResult>;
      const available = () => {
        cancelled(this.lifetime);
        this.available();
      };
      stored = Object.freeze({
        ...frozenClone({
          name: metadata.name,
          description: metadata.description,
          executionPolicy: metadata.executionPolicy,
          ...(metadata.controlActions
            ? { controlActions: metadata.controlActions }
            : {}),
          ...(metadata.usage ? { usage: metadata.usage } : {}),
          source: {
            type: "extension" as const,
            extensionId,
            name: metadata.name,
          },
        }),
        ...(executeControl
          ? {
              executeControl: async (
                context: SubagentControlInvocation,
                input: unknown,
              ) => {
                available();
                cancelled(context.signal);
                if ("tools" in context || "model" in context)
                  throw new ExtensionLifecycleError(
                    "Control received a broad port",
                    extensionId,
                  );
                return executeControl(context, input as T);
              },
            }
          : {}),
        parse: (args: string) => {
          available();
          return parse(args);
        },
        execute: async (
          context: ExtensionCommandInvocation | SideQueryCommandInvocation,
          input: unknown,
        ) => {
          available();
          cancelled(context.signal);
          if (metadata.executionPolicy === "side_query" && "tools" in context)
            throw new ExtensionLifecycleError(
              "Side command received an invalid execution context.",
              extensionId,
            );
          // Cooperative cancellation: wait for callbacks/tools to settle before releasing ownership.
          const result = await execute(context, input as T);
          cancelled(context.signal);
          return result;
        },
      });
    } catch (cause) {
      if (cause instanceof ExtensionLifecycleError) throw cause;
      throw new ExtensionLifecycleError(
        `Invalid command contribution from extension ${extensionId}.`,
        extensionId,
        cause,
      );
    }
    this.commands.set(stored.name, stored);
    let removed = false;
    return {
      dispose: () => {
        if (removed) return;
        removed = true;
        this.commands.delete(stored.name);
      },
    };
  }
  seal(): void {
    this.sealed = true;
  }
  dispose(): void {
    this.closed = true;
    this.commands.clear();
  }
  private available(): void {
    if (!this.sealed || this.closed)
      throw new ExtensionLifecycleError(
        "Extension commands are not available.",
      );
    this.assertAvailable();
  }
  descriptors(): readonly ExtensionCommandDescriptor[] {
    this.available();
    return Object.freeze(
      [...this.commands.values()].map(
        ({
          name,
          description,
          usage,
          source,
          executionPolicy,
          controlActions,
        }) =>
          Object.freeze({
            name,
            description,
            usage,
            source,
            executionPolicy,
            controlActions,
          }),
      ),
    );
  }
  get(name: string): RegisteredExtensionCommand {
    this.available();
    const command = this.commands.get(name);
    if (!command)
      throw new ExtensionLifecycleError(
        `Extension command /${name} is not available.`,
      );
    return command;
  }
}
