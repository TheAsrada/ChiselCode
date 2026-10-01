import { observedContextSnapshot } from "../core/context-usage.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import type { Session, TokenUsage } from "../types/domain.js";
import { estimateCost } from "./store.js";
export function attachSessionRecorder(
  session: Session,
  events: RuntimeEventBus,
): () => void {
  return events.subscribe((event) => {
    if (event.type === "context_updated" && event.contextSnapshot)
      session.contextSnapshot = event.contextSnapshot;
    if (event.type === "turn_state" && session.runtime)
      session.runtime.state =
        event.state as import("../runtime/turn-state.js").TurnState;
    if (
      event.type === "provider_turn_completed" &&
      event.message &&
      event.usage
    ) {
      session.messages.push(event.message);
      addUsage(session, event.usage);
      const prior = session.contextSnapshot;
      const observed = observedContextSnapshot(
        session.providerId,
        session.model,
        event.usage,
        {
          id: session.model,
          contextWindow: prior?.contextWindow,
          limitsSource: prior?.windowSource,
        },
      );
      if (observed.observedInputTokens > 0)
        session.contextSnapshot = {
          ...observed,
          localTokens: prior?.localTokens,
          connectionId: prior?.connectionId,
        };
    }
    if (
      (event.type === "tool_completed" || event.type === "tool_failed") &&
      event.result &&
      event.invocationId
    ) {
      if (event.result.diffs?.length || event.result.fileDiff) {
        session.fileDiffs ??= {};
        for (const [index, diff] of (
          event.result.diffs ?? [event.result.fileDiff]
        ).entries())
          if (diff)
            session.fileDiffs[
              index === 0
                ? event.invocationId
                : `${event.invocationId}:${index}`
            ] = diff;
      }
    }
  });
}
function addUsage(session: Session, usage: TokenUsage) {
  const hadPriorUsage =
    session.totalTokens.inputTokens + session.totalTokens.outputTokens > 0 ||
    session.messages.filter((message) => message.role === "assistant").length >
      1;
  session.totalTokens.inputTokens += usage.inputTokens;
  session.totalTokens.outputTokens += usage.outputTokens;
  session.totalTokens.cacheReadTokens =
    (session.totalTokens.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  session.totalTokens.cacheCreationTokens =
    (session.totalTokens.cacheCreationTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0);
  const estimate = estimateCost(
    session.providerId,
    session.model,
    usage.inputTokens,
    usage.outputTokens,
  );
  if (estimate.usd !== undefined) session.totalCost += estimate.usd;
  const previousUnknown =
    session.costEstimate?.source === "unknown" && hadPriorUsage;
  session.costEstimate =
    estimate.source === "unknown" || previousUnknown
      ? { source: "unknown" }
      : { usd: session.totalCost, source: "estimated" };
}
