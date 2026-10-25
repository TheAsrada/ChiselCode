/** @jsxImportSource @opentui/react */
import type { TextRenderable } from "@opentui/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Palette } from "./appearance.js";
import {
  easeOut,
  MotionClock,
  type MotionPreference,
  mixColor,
  motionEnabled,
} from "./motion.js";

const MotionContext = createContext<{
  clock?: MotionClock;
  enabled: boolean;
  preference: MotionPreference;
  saving: boolean;
  change?(preference: MotionPreference): Promise<void>;
}>({ enabled: false, preference: "reduced", saving: false });

export function OpenTuiMotion({
  children,
  preference = "full",
  onChange,
}: {
  children: ReactNode;
  preference?: MotionPreference;
  onChange?(preference: MotionPreference): void | Promise<void>;
}) {
  const clock = useMemo(() => new MotionClock(), []);
  const [current, setCurrent] = useState(preference);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      clock.dispose();
    },
    [clock],
  );
  return (
    <MotionContext.Provider
      value={{
        clock,
        enabled: motionEnabled(current),
        preference: current,
        saving,
        change: async (next) => {
          if (pending.current || next === current) return;
          pending.current = true;
          setSaving(true);
          try {
            await onChange?.(next);
            if (alive.current) setCurrent(next);
          } finally {
            pending.current = false;
            if (alive.current) setSaving(false);
          }
        },
      }}
    >
      {children}
    </MotionContext.Provider>
  );
}
export const useMotion = () => useContext(MotionContext);

/** Finite color changes repaint a small control, preserving its identity and hit area. */
export function useAnimatedColor(
  target: string,
  duration = 140,
  animate = true,
): string {
  const { clock, enabled } = useMotion();
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (!clock || !enabled || !animate) {
      current.current = target;
      setValue(target);
      return;
    }
    const from = current.current;
    if (from === target) return;
    const start = performance.now();
    return clock.add((now) => {
      const t = Math.min(1, (now - start) / duration);
      current.current = mixColor(from, target, easeOut(t));
      setValue(current.current);
      return t < 1;
    });
  }, [clock, enabled, target, duration, animate]);
  return enabled && animate ? value : target;
}

/** No movement or delayed input: a dialog only fades its backdrop in-place. */
export function useEntrance(duration = 160, active = true): number {
  const { clock, enabled } = useMotion();
  const [progress, setProgress] = useState(enabled && active ? 0 : 1);
  const entered = useRef(false);
  useEffect(() => {
    if (entered.current || !clock || !enabled || !active) {
      entered.current = true;
      setProgress(1);
      return;
    }
    entered.current = true;
    const start = performance.now();
    return clock.add((now) => {
      const t = Math.min(1, (now - start) / duration);
      setProgress(easeOut(t));
      return t < 1;
    });
  }, [clock, enabled, active, duration]);
  return enabled && active ? progress : 1;
}

/** Only active indicators subscribe; text, native editor and transcript do not tick. */
export function ActivityIndicator({
  palette,
  paused = false,
  id,
}: {
  palette: Palette;
  paused?: boolean;
  id?: string;
}) {
  const { clock, enabled } = useMotion();
  const node = useRef<TextRenderable>(null);
  useEffect(() => {
    if (!clock || !enabled || paused) return;
    const start = performance.now();
    let previous = -1;
    return clock.add((now) => {
      const next = Math.floor((now - start) / 80) % 10;
      if (next !== previous) {
        previous = next;
        if (node.current && !node.current.isDestroyed)
          node.current.content = SPINNER_FRAMES[next] ?? "⠋";
      }
      return true;
    });
  }, [clock, enabled, paused]);
  return (
    <text
      id={id}
      ref={node}
      width={1}
      height={1}
      flexShrink={0}
      selectable={false}
      fg={paused ? palette.yellow : palette.accent}
      content={paused ? "◆" : enabled ? SPINNER_FRAMES[0] : "·"}
    />
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
