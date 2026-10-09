import { randomUUID } from "node:crypto";
import { emptySpend } from "../../src/models/accounting.js";
import { captureConversation } from "../../src/models/context.js";
import { SUBAGENT_LIMITS } from "../../src/subagents/config.js";
import type { SubagentRecord } from "../../src/subagents/contracts.js";
export function childFixture(
  ownerId: string = randomUUID(),
  root = process.cwd(),
): SubagentRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    rootOwnerId: ownerId,
    parentSessionId: ownerId,
    parentConversationId: randomUUID(),
    parentGeneration: 0,
    parentRoot: root,
    parentTurnId: randomUUID(),
    invocationId: randomUUID(),
    extensionId: "builtin.subagents",
    depth: 1,
    ordinal: 1,
    label: "Разобрать обработку ошибок",
    task: "Изучи код и укажи конкретные ограничения. Основной черновик сохраняется.",
    mode: "readonly",
    status: "running",
    providerId: "openai-compatible",
    profileId: "fixture",
    model: "fixture-model",
    acceptedAt: now,
    updatedAt: now,
    revision: 1,
    context: captureConversation().provenance,
    step: "Читает src/runtime.ts",
    text: "Проверено чтением реального файла.\n\n```ts\nconst result = await task();\n```\n",
    textTruncated: false,
    progress: [
      {
        type: "tool",
        sequence: 1,
        at: now,
        text: "read_file: выполнено",
        tool: "read_file",
        outcome: "completed",
      },
    ],
    spend: emptySpend(),
    attempts: [],
    consumption: { accountedTokens: 0, tools: 0, iterations: 0 },
    limits: {
      deadlineMs: SUBAGENT_LIMITS.deadlineMs,
      tokens: SUBAGENT_LIMITS.childTokens,
      iterations: 12,
      attempts: 24,
      tools: 100,
    },
    cleanup: { quiescent: false },
    operationKey: randomUUID(),
  };
}
