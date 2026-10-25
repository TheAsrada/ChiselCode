/** @jsxImportSource @opentui/react */
import type { TextRenderable } from "@opentui/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Palette } from "./appearance.js";
import { useMotion } from "./opentui-motion.js";
import { requestActivity } from "./request-activity.js";
import { ACTIVITY_MORPH_MS, activityFrame } from "./request-activity-frame.js";
import type { TuiController } from "./tui-controller.js";

/** Only this native text buffer animates; the editor and transcript never tick. */
export function OpenTuiRequestStatus({
  controller,
  palette,
  width,
  awaitingApproval = false,
}: {
  controller: TuiController;
  palette: Palette;
  width: number;
  awaitingApproval?: boolean;
}) {
  const subscribe = useCallback(
    (changed: () => void) => controller.subscribe(changed),
    [controller],
  );
  const snapshot = useCallback(() => controller.snapshot, [controller]);
  const view = useSyncExternalStore(subscribe, snapshot);
  const { clock, enabled } = useMotion();
  const startedAt = view.requestStartedAt;
  const phase =
    awaitingApproval || view.awaitingApproval
      ? requestActivity("approval")
      : (view.requestActivity ?? requestActivity("thinking"));
  const node = useRef<TextRenderable>(null);
  const current = useRef({ phase, palette, width, enabled });
  current.current = { phase, palette, width, enabled };
  const visual = useRef({
    kind: phase.kind,
    displayed: phase.icon,
    from: undefined as string | undefined,
    transitionAt: 0,
    epoch: performance.now(),
    request: startedAt,
  });
  const draw = useCallback(
    (now: number) => {
      if (!node.current || node.current.isDestroyed) return false;
      const { phase, palette, width, enabled } = current.current;
      const state = visual.current;
      const morph = state.from
        ? Math.min(
            1,
            Math.max(0, (now - state.transitionAt) / ACTIVITY_MORPH_MS),
          )
        : 1;
      state.displayed =
        enabled && phase.moving && state.from && morph < 0.38
          ? state.from
          : enabled && phase.moving && state.from && morph < 0.6
            ? "·"
            : phase.icon;
      node.current.content = activityFrame({
        activity: phase,
        palette,
        width: Math.max(1, Math.min(44, width - 1)),
        age: now - state.epoch,
        elapsedMs: controller.requestElapsedMs,
        enabled,
        morph,
        previousIcon: state.from,
      });
      return true;
    },
    [controller],
  );
  useLayoutEffect(() => {
    const state = visual.current;
    const now = performance.now();
    if (state.request !== startedAt) {
      state.request = startedAt;
      state.epoch = now;
      state.from = undefined;
    } else if (state.kind !== phase.kind) {
      state.from =
        enabled && phase.moving && state.displayed !== phase.icon
          ? state.displayed
          : undefined;
      state.transitionAt = now;
    }
    if (!enabled || !phase.moving) state.from = undefined;
    state.kind = phase.kind;
    draw(now);
  });
  const moving = enabled && phase.moving;
  useEffect(() => {
    if (startedAt === undefined) return;
    if (moving && clock) return clock.add(draw);
    const timer = setInterval(() => {
      if (!draw(performance.now())) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [clock, moving, startedAt, draw]);
  if (startedAt === undefined) return null;
  return (
    <box width="100%" height={1} flexShrink={0} paddingLeft={1}>
      <text
        id="request-status"
        ref={node}
        width={Math.max(1, Math.min(44, width - 1))}
        height={1}
        flexShrink={0}
        selectable={false}
        content=""
      />
    </box>
  );
}
