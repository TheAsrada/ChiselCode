import type { ChatMessage } from "../types/domain.js";
import type { StructuredSummary } from "./types.js";
export function emptySummary(): StructuredSummary {
  return {
    goal: "",
    userConstraints: [],
    relevantArchitecture: [],
    decisions: [],
    workCompleted: [],
    changedFiles: {},
    verification: [],
    failedAttempts: [],
    openProblems: [],
    importantReferences: [],
    nextAction:
      "Continue the user's task, inspect current files and verify the changes.",
  };
}
/** Deterministic evidence summary. A model summarizer can implement the same contract. */
export function summarize(
  messages: ChatMessage[],
  prior?: StructuredSummary,
): StructuredSummary {
  const summary = structuredClone(prior ?? emptySummary());
  const calls = new Map(
    messages.flatMap((message) =>
      message.content.flatMap((item) =>
        item.type === "tool_use" ? [[item.id, item] as const] : [],
      ),
    ),
  );
  for (const message of messages)
    for (const item of message.content) {
      if (item.type === "text") {
        if (message.role === "user") {
          summary.goal ||= item.text;
          // Never silently discard user constraints to make room for tool logs.
          if (!summary.userConstraints.includes(item.text))
            summary.userConstraints.push(item.text);
        } else {
          summary.nextAction =
            item.text.split("\n").filter(Boolean).at(-1)?.slice(0, 1000) ??
            summary.nextAction;
          for (const line of item.text.split("\n").filter(Boolean)) {
            if (/decid|choose|решени|выбран/i.test(line))
              summary.decisions.push(line.slice(0, 1000));
            if (/architect|структур|интерфейс/i.test(line))
              summary.relevantArchitecture.push(line.slice(0, 1000));
          }
        }
      } else if (item.type === "tool_use") {
        const path =
          typeof item.input.path === "string" ? item.input.path : undefined;
        if (path) summary.importantReferences.push(`${item.name}: ${path}`);
      } else {
        const call = calls.get(item.toolUseId);
        const command =
          call?.name === "run_shell" && typeof call.input.command === "string"
            ? call.input.command
            : undefined;
        const prefix = command
          ? `run_shell [${command}]: `
          : `${call?.name ?? "tool"}: `;
        const detail = prefix + item.content.slice(0, 1500);
        if (item.isError) {
          summary.failedAttempts.push(detail);
          summary.openProblems.push(detail);
        } else {
          if (
            /^(Updated|Wrote|Edited|Deleted|Created|User skill)/i.test(
              item.content,
            )
          )
            summary.workCompleted.push(detail);
          if (command && /test|typecheck|lint|check|build/i.test(command)) {
            summary.openProblems = summary.openProblems.filter(
              (problem) => !problem.startsWith(prefix),
            );
            summary.verification = summary.verification.filter(
              (result) => !result.startsWith(prefix),
            );
            summary.verification.push(detail);
          }
        }
      }
    }
  for (const field of [
    "relevantArchitecture",
    "decisions",
    "workCompleted",
    "verification",
    "failedAttempts",
    "openProblems",
    "importantReferences",
  ] as const)
    summary[field] = [...new Set(summary[field])].slice(-32);
  return summary;
}
export function summaryText(summary: StructuredSummary): string {
  const fields = {
    Goal: summary.goal,
    "User constraints": summary.userConstraints,
    "Relevant architecture": summary.relevantArchitecture,
    Decisions: summary.decisions,
    "Work completed": summary.workCompleted,
    "Changed files": summary.changedFiles,
    Verification: summary.verification,
    "Failed attempts": summary.failedAttempts,
    "Open problems": summary.openProblems,
    "Important references": summary.importantReferences,
    "Next action": summary.nextAction,
  };
  return Object.entries(fields)
    .map(
      ([name, value]) =>
        `# ${name}\n${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("\n\n");
}
