import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { worktreeServiceToken } from "../../src/extensions/builtins/worktrees.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { attachExtensionTools } from "../../src/extensions/tools.js";
import { chiselHomeDir } from "../../src/paths/home.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { EditingService } from "../../src/tools/editing/service.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";

// Test-only process barrier: production has no crash flags or fixture loader.
const [requestedRoot, action, id, marker] = process.argv.slice(2);
if (!requestedRoot || !action || !marker)
  throw new Error("Expected root/action/id/marker");
const host = new ExtensionHost(defaultExtensions());
const scope = await host.open(requestedRoot);
const root = scope.workspaceRoot;
const session = createSession(root, "openai", "fixture");
const store = await projectSessionStore(root);
const pause = async () => {
  await writeFile(marker, "checkpoint");
  await new Promise<void>(() => {});
};
const gate = new ApprovalGate(
  DEFAULT_PROJECT_CONFIG,
  { autoApprove: false, nonInteractive: false, allowedTools: new Set() },
  { requestApproval: async () => "approved" },
);
const tools = createLocalToolRuntime(
  root,
  DEFAULT_PROJECT_CONFIG.ignorePatterns,
  gate,
  session,
  [],
  {
    worktrees: scope.services.get(worktreeServiceToken),
    checkpoint: async () => {
      await store.save(session);
      if (action === "apply") return;
      const directory = join(chiselHomeDir(), "worktrees");
      for (const repository of await readdir(directory).catch(() => [])) {
        const registry = JSON.parse(
          await readFile(join(directory, repository, "registry.json"), "utf8"),
        );
        for (const record of Object.values(registry.records) as {
          intent?: { action: string; phase: string };
        }[])
          if (
            record.intent?.action === action &&
            record.intent.phase === "executing"
          )
            await pause();
      }
    },
  },
);
if (action === "apply")
  tools.context.editing = new EditingService(
    tools.context.workspace,
    tools.context.editing.observations,
    true,
    async (_operation, index) => {
      if (index === 1) await pause();
    },
  );
await attachExtensionTools(scope, tools.catalog);
await mkdir(join(chiselHomeDir(), "worktrees"), { recursive: true });
const result = await tools.executor.execute({
  id: "crash-operation",
  name: `ext:builtin.worktrees:${action}`,
  input: action === "create" ? { label: "Crash create" } : { id },
});
await host.dispose();
throw new Error(`Crash barrier was not reached: ${result.output}`);
