import {
  type ChiselExtension,
  type ContextProviderSnapshot,
  createServiceToken,
  type Disposable,
} from "../../src/extensions/index.js";

export interface FixtureWorkspaceService extends Disposable {
  value: number;
  disposed: number;
}

/** A linked test extension, not a pseudo LSP/memory implementation or a loader. */
export function extensionFixture() {
  const token =
    createServiceToken<FixtureWorkspaceService>("fixture/workspace");
  const services = new Map<string, FixtureWorkspaceService>();
  const snapshots: ContextProviderSnapshot[] = [];
  let activations = 0;
  const extension: ChiselExtension = {
    id: "fixture",
    activate(ctx) {
      // Each workspace owns a fresh state object; the definition has no current-workspace fields.
      const service: FixtureWorkspaceService = {
        value: 0,
        disposed: 0,
        dispose() {
          this.disposed++;
        },
      };
      ctx.add(service);
      ctx.services.provide(token, service);
      services.set(ctx.workspaceRoot, service);
      activations++;
      const workspaceService = ctx.services.get(token);
      ctx.contextProviders.register({
        id: "state",
        collect(snapshot) {
          snapshots.push(snapshot);
          return {
            text: `EPHEMERAL_FIXTURE state=${workspaceService.value}; request=${snapshot.userPrompt}`,
          };
        },
      });
      ctx.guards.afterPrepare((snapshot) =>
        snapshot.tool.name === "fixture_update" && snapshot.input.deny === true
          ? { action: "deny", reason: "Fixture action is disabled." }
          : { action: "continue" },
      );
    },
  };
  return {
    extension,
    token,
    services,
    snapshots,
    activations: () => activations,
  };
}
