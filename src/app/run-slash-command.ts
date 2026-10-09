import {
  composeCommandProjection,
  resolveSlashCommand,
  splitSlashCommand,
} from "../commands/slash.js";
import { loadGlobalConfig } from "../config/load.js";
import {
  defaultExtensions,
  withOwnedExtensionHost,
} from "../extensions/composition.js";
import { captureConversation } from "../models/context.js";
import { ModelRequestService } from "../models/service.js";
import { getProviderCatalog } from "../providers/catalog.js";
import type { ApprovalResolver } from "../security/approval.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { invocableSkills, loadSkills } from "../skills/skills.js";
import { runSideQueryCommand } from "./model-command.js";
import { captureModelConfiguration } from "./model-runtime.js";
import { runExtensionCommand } from "./run-command.js";
import type { RunOptions } from "./run-prompt.js";

/** Ordinary one-shot CLI supports contributed commands without a synthetic agent prompt. */
export async function runSlashCommand(
  input: string,
  options: RunOptions,
  resolver: ApprovalResolver,
): Promise<{ exitCode: number } | undefined> {
  const head = splitSlashCommand(input);
  if (!head) return;
  const acceptedAt = Date.now();
  const root = options.cwd ?? process.cwd();
  const store = await projectSessionStore(root);
  const previous = options.resume
    ? await store.interruptSideQueries((await store.resolve(options.resume)).id)
    : undefined;
  const capture = captureConversation(previous);
  const global = await loadGlobalConfig(options.configPath);
  const { registry } = await getProviderCatalog();
  const service = new ModelRequestService();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  try {
    return await withOwnedExtensionHost(
      defaultExtensions([], options),
      async (host) => {
        const scope = await host.open(root);
        const descriptor = resolveSlashCommand(
          composeCommandProjection(
            invocableSkills(loadSkills(root)),
            scope.commands.descriptors(),
          ),
          input,
        );
        if (descriptor?.source.type !== "extension") return undefined;
        const command = scope.commands.get(descriptor.source.name);
        let parsed: unknown;
        try {
          parsed = command.parse(head.args);
        } catch {
          throw new Error(
            `/${command.name} · ${command.source.extensionId}: ${command.usage ?? "неверные аргументы"}`,
          );
        }
        const prepared = { command, input: parsed };
        const result =
          command.executionPolicy === "side_query"
            ? (
                await runSideQueryCommand(
                  prepared,
                  scope,
                  options,
                  {
                    model: captureModelConfiguration(
                      global,
                      registry,
                      options,
                      previous,
                    ),
                    capture,
                    acceptedAt,
                    conversationId: previous?.id ?? crypto.randomUUID(),
                    generation: 0,
                  },
                  service,
                  abort.signal,
                )
              ).result
            : (
                await runExtensionCommand(
                  prepared,
                  scope,
                  options,
                  resolver,
                  {},
                  abort.signal,
                )
              ).result;
        if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else if ("status" in result) {
          if (result.text) process.stdout.write(`${result.text}\n`);
          if (result.error) process.stderr.write(`${result.error.message}\n`);
        } else process.stdout.write(`${result.output}\n`);
        return {
          exitCode:
            "status" in result
              ? result.status === "completed"
                ? 0
                : 1
              : result.isError || result.requiresApproval
                ? 1
                : 0,
        };
      },
    );
  } finally {
    process.off("SIGINT", cancel);
    await service.dispose();
  }
}
