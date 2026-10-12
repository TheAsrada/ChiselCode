/** @jsxImportSource @opentui/react */
import { useSyncExternalStore } from "react";
import {
  type SubagentDescriptor,
  subagentActive,
} from "../subagents/contracts.js";
import type { Palette } from "./appearance.js";
import { elapsedSeconds } from "./request-timing.js";

// Only time rows subscribe. One clock for all visible child surfaces; no hidden timer.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => now;
const idle = () => () => {};
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
    timer.unref();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function useElapsedClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, snapshot, snapshot);
}
export function SubagentElapsed({
  record,
  palette,
}: {
  record: SubagentDescriptor;
  palette: Palette;
}) {
  const active = subagentActive(record.status);
  const tick = useSyncExternalStore(
    active ? subscribe : idle,
    snapshot,
    snapshot,
  );
  const end = active ? tick : Date.parse(record.finishedAt ?? record.updatedAt);
  return (
    <text height={1} fg={palette.muted}>
      Время: {elapsedSeconds(Math.max(0, end - Date.parse(record.acceptedAt)))}
    </text>
  );
}
