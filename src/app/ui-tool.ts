import type { RegisteredExtensionCommand } from "../extensions/commands.js";
import type { ExtensionCommandInvocation } from "../extensions/contracts.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { frozenClone } from "../extensions/lifecycle.js";
import type { ToolHandler } from "../tools/types.js";
import type { JsonObject } from "../types/domain.js";
import type { PreparedExtensionCommand } from "./run-command.js";

const accepted = new WeakMap<
  PreparedExtensionCommand,
  {
    scope: WorkspaceExtensionScope;
    toolScope: WorkspaceExtensionScope;
    handler: ToolHandler;
    assertOwner(): void;
  }
>();
/** Core application entry, not an extension export and not a slash command. */
export async function prepareUiToolInvocation(
  scope: WorkspaceExtensionScope,
  extensionId: string,
  tool: string,
  args: JsonObject,
  assertOwner: () => void,
  toolScope: WorkspaceExtensionScope = scope,
): Promise<PreparedExtensionCommand> {
  scope.assertUsable();
  toolScope.assertUsable();
  if (toolScope.workspaceRoot !== scope.workspaceRoot)
    throw new Error("UI tool belongs to a different workspace.");
  assertOwner();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool))
    throw new Error("Недопустимое действие инструмента.");
  const name = `ext:${extensionId}:${tool}`;
  const input = frozenClone(args);
  const handler = await toolScope.tools.getHandler(name);
  handler.parse(input);
  assertOwner();
  const command: RegisteredExtensionCommand = Object.freeze({
    name: "ui-action",
    description: "Действие интерфейса",
    executionPolicy: "foreground",
    source: Object.freeze({
      type: "extension",
      extensionId,
      name: "ui-action",
    }),
    parse: () => input,
    execute: async (
      invocation:
        | ExtensionCommandInvocation
        | import("../extensions/contracts.js").SideQueryCommandInvocation,
    ) => {
      assertOwner();
      scope.assertUsable();
      toolScope.assertUsable();
      if ((await toolScope.tools.getHandler(name)) !== handler)
        throw new Error("Инструмент больше недоступен.");
      return (invocation as ExtensionCommandInvocation).tools.execute(
        name,
        input,
      );
    },
  });
  const prepared = Object.freeze({ command, input });
  accepted.set(prepared, { scope, toolScope, handler, assertOwner });
  return prepared;
}
export function assertUiToolInvocation(
  prepared: PreparedExtensionCommand,
  scope: WorkspaceExtensionScope,
): boolean {
  const proof = accepted.get(prepared);
  if (!proof) return false;
  if (proof.scope !== scope) throw new Error("Владелец действия изменён.");
  proof.assertOwner();
  scope.assertUsable();
  proof.toolScope.assertUsable();
  return true;
}
/** Private attestation, never a model/UI supplied handler or execution capability. */
export function uiToolAttachment(
  prepared: PreparedExtensionCommand,
  scope: WorkspaceExtensionScope,
) {
  if (!assertUiToolInvocation(prepared, scope)) return undefined;
  const proof = accepted.get(prepared)!;
  return {
    handler: proof.toolScope === scope ? undefined : proof.handler,
    signal: proof.toolScope.signal,
  };
}
