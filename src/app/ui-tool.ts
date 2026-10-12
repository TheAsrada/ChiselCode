import type { RegisteredExtensionCommand } from "../extensions/commands.js";
import type { ExtensionCommandInvocation } from "../extensions/contracts.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { frozenClone } from "../extensions/lifecycle.js";
import type { JsonObject } from "../types/domain.js";
import type { PreparedExtensionCommand } from "./run-command.js";

const accepted = new WeakMap<
  PreparedExtensionCommand,
  { scope: WorkspaceExtensionScope; assertOwner(): void }
>();
/** Core application entry, not an extension export and not a slash command. */
export async function prepareUiToolInvocation(
  scope: WorkspaceExtensionScope,
  extensionId: string,
  tool: string,
  args: JsonObject,
  assertOwner: () => void,
): Promise<PreparedExtensionCommand> {
  scope.assertUsable();
  assertOwner();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool))
    throw new Error("Недопустимое действие инструмента.");
  const name = `ext:${extensionId}:${tool}`;
  const input = frozenClone(args);
  const handler = await scope.tools.getHandler(name);
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
      if ((await scope.tools.getHandler(name)) !== handler)
        throw new Error("Инструмент больше недоступен.");
      return (invocation as ExtensionCommandInvocation).tools.execute(
        name,
        input,
      );
    },
  });
  const prepared = Object.freeze({ command, input });
  accepted.set(prepared, { scope, assertOwner });
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
  return true;
}
