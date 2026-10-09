import { z } from "zod";
import { utf8Prefix } from "../models/context.js";
import { RuntimeError } from "../runtime/errors.js";
import { RuntimeEventBus } from "../runtime/events.js";
import { ApprovalGate } from "../security/approval.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { createSession } from "../sessions/store.js";
import { SUBAGENT_LIMITS } from "../subagents/config.js";
import type {
  SubagentOwnerBinding,
  SubagentService,
} from "../subagents/service.js";
import { defineTool } from "../tools/handler.js";
import { createLocalToolRuntime } from "../tools/local-runtime.js";
import { terminalSafeText } from "../ui/terminal-text.js";
import {
  bindSubagentWorktreeRead,
  executeWorktreePlan,
} from "../worktrees/capability.js";
import type { SubagentControls } from "./subagent-binding.js";

export function subagentControls(
  service: SubagentService,
  owner: SubagentOwnerBinding,
): SubagentControls {
  const port = service.controlFor(
    owner.session.id,
    owner.conversationId,
    owner.generation,
  );
  return {
    port,
    busy: () => service.busy(owner.session.id),
    cancel: () => service.cancelOwner(owner.session.id),
    close: () => service.closeOwner(owner.session.id),
    wait: () => service.drain(owner.session.id, SUBAGENT_LIMITS.shutdownMs),
    inspect: async (id, view) => {
      const record = await port.status(id);
      if (view === "history") {
        if (!record.sessionId || !record.root)
          return { text: "История появится после подготовки задачи." };
        const session = await (await projectSessionStore(record.root)).load(
          record.sessionId,
        );
        await port.status(id);
        if (
          session.subagent?.ownerId !== owner.session.id ||
          session.subagent.id !== id
        )
          throw new RuntimeError(
            "PERMISSION_DENIED",
            "История принадлежит другой задаче.",
          );
        const text = session.messages
          .map(
            (message) =>
              `[${message.role}]\n${message.content.map((block) => (block.type === "text" ? block.text : block.type === "tool_use" ? `Инструмент ${block.name}` : block.type === "tool_result" ? `${block.isError ? "Ошибка" : "Результат"}: ${block.content}` : "")).join("\n")}`,
          )
          .join("\n\n");
        return {
          text: utf8Prefix(terminalSafeText(owner.redactor.text(text)), 65536),
        };
      }
      if (!record.worktree)
        return {
          text:
            record.mode === "readonly"
              ? "Помощник работает только на чтение; отдельной копии и изменений нет."
              : "Рабочая копия ещё не подготовлена.",
        };
      const session = createSession(
        owner.root,
        record.providerId,
        record.model,
      );
      session.subagent = {
        id,
        ownerId: owner.session.id,
        parentRoot: owner.root,
        mode: "readonly",
        depth: 1,
      };
      session.title = `Просмотр: ${record.label}`;
      const store = await projectSessionStore(owner.root);
      await store.save(session);
      const tools = createLocalToolRuntime(
        owner.root,
        owner.config.ignorePatterns,
        new ApprovalGate(
          owner.config,
          {
            autoApprove: false,
            allowedTools: new Set(),
            nonInteractive: !owner.options.interactive,
          },
          { requestApproval: async () => "unavailable" },
        ),
        session,
        [],
        {
          mode: "plan",
          signal: owner.signal,
          events: new RuntimeEventBus(session.id),
          checkpoint: () => store.save(session),
          worktrees: service.worktrees.workspace(owner.root, owner.signal),
          sanitizeResult: (value) => owner.redactor.value(value),
        },
      );
      const name = "ext:builtin.subagents:inspect_changes";
      tools.catalog.register(
        defineTool(
          {
            name,
            description: "Просмотр изменений выбранного помощника",
            effect: "read",
            permission: "read",
            parallelSafe: false,
            source: {
              type: "extension",
              extensionId: "builtin.subagents",
              originalName: "inspect_changes",
            },
          },
          z.object({ id: z.uuid() }),
          async (context, values) =>
            bindSubagentWorktreeRead(
              await tools.context.worktrees!.prepare("diff", values, context),
            ),
          executeWorktreePlan,
        ),
      );
      const result = await tools.executor.execute(
        {
          id: `inspect:${id}:${record.revision}`,
          name,
          input: { id: record.worktree.id },
        },
        owner.signal,
      );
      await port.status(id);
      if (result.isError)
        throw new RuntimeError("WORKTREE_UNAVAILABLE", result.output);
      return { text: terminalSafeText(result.output), diffs: result.diffs };
    },
  };
}
