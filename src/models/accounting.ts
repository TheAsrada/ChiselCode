import type { Session, TokenUsage } from "../types/domain.js";
import type { ModelSpend, SideQueryRecord } from "./contracts.js";

export function emptySpend(): ModelSpend {
  return {
    usage: { inputTokens: 0, outputTokens: 0 },
    knownCost: 0,
    unknownCost: false,
    unknownUsage: false,
  };
}
export function addTokenUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens =
    (target.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  target.cacheCreationTokens =
    (target.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
}
export function aggregateSpend(values: Iterable<ModelSpend>): ModelSpend {
  const result = emptySpend();
  for (const spend of values) {
    addTokenUsage(result.usage, spend.usage);
    result.knownCost += spend.knownCost;
    result.unknownCost ||= spend.unknownCost;
    result.unknownUsage ||= spend.unknownUsage;
  }
  return result;
}
export function sideSpend(
  session: Pick<Session, "sideQuerySpend">,
): ModelSpend {
  return aggregateSpend(Object.values(session.sideQuerySpend ?? {}));
}
export function spendForRecord(record: SideQueryRecord): ModelSpend {
  return {
    usage: record.usage
      ? { ...record.usage }
      : { inputTokens: 0, outputTokens: 0 },
    knownCost: record.knownCost,
    unknownCost: record.cost.source === "unknown",
    unknownUsage: record.usageSource !== "observed",
  };
}
export function ensureMainSpend(session: Session): ModelSpend {
  if (session.mainSpend) return session.mainSpend;
  const side = sideSpend(session);
  const usage = { ...session.totalTokens };
  usage.inputTokens = Math.max(0, usage.inputTokens - side.usage.inputTokens);
  usage.outputTokens = Math.max(
    0,
    usage.outputTokens - side.usage.outputTokens,
  );
  usage.cacheReadTokens = Math.max(
    0,
    (usage.cacheReadTokens ?? 0) - (side.usage.cacheReadTokens ?? 0),
  );
  usage.cacheCreationTokens = Math.max(
    0,
    (usage.cacheCreationTokens ?? 0) - (side.usage.cacheCreationTokens ?? 0),
  );
  session.mainSpend = {
    usage,
    knownCost: Math.max(0, session.totalCost - side.knownCost),
    unknownCost: session.costEstimate?.source === "unknown",
    unknownUsage: false,
  };
  return session.mainSpend;
}
/** Compatibility totals are derived; they are never incremented with the side subtotal twice. */
export function recomputeSessionSpend(session: Session): void {
  const total = aggregateSpend([ensureMainSpend(session), sideSpend(session)]);
  session.totalTokens = { ...total.usage };
  session.totalCost = total.knownCost;
  session.costEstimate = total.unknownCost
    ? { source: "unknown" }
    : { source: "estimated", usd: total.knownCost };
}
