import { RGBA, StyledText } from "@opentui/core";
import type { Palette } from "./appearance.js";
import { easeOut, mixColor } from "./motion.js";
import type { RequestActivity } from "./request-activity.js";
import { elapsedSeconds } from "./request-timing.js";
import { terminalLine } from "./terminal-text.js";

export const ACTIVITY_MORPH_MS = 180;
const dots = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128],
];
type Cell = { text: string; color: string };

/** Five fixed terminal cells; motion happens inside the glyphs and their colors. */
function emblem(
  activity: RequestActivity,
  palette: Palette,
  age: number,
  morph: number,
  previous?: string,
): Cell[] {
  const moving = activity.moving;
  const color =
    activity.kind === "approval"
      ? palette.yellow
      : activity.kind === "failed"
        ? palette.red
        : activity.kind === "stopping"
          ? palette.muted
          : palette.accent;
  const t = Math.min(1, Math.max(0, morph));
  const thought = activity.kind === "thinking" || activity.kind === "answering";
  const phase =
    (age / (activity.kind === "answering" ? 2200 : 1400)) * Math.PI * 2;
  const beat = moving ? (Math.sin(phase) + 1) / 2 : 1;
  const masks = [0, 0, 0];
  const lights = [0, 0, 0];
  if (moving) {
    const orbit = thought || activity.kind === "searching" ? 2.25 : 0.3;
    const radius =
      t < 0.5
        ? 2.3 * (1 - easeOut(t * 2))
        : t < 1
          ? orbit * easeOut((t - 0.5) * 2)
          : orbit;
    for (let tail = 3; tail >= 0; tail--) {
      const angle = phase - tail * 0.42;
      const x = Math.max(
        0,
        Math.min(5, Math.round(2.5 + Math.cos(angle) * radius)),
      );
      const y = Math.max(
        0,
        Math.min(3, Math.round(1.5 + Math.sin(angle) * 1.35)),
      );
      const cell = Math.floor(x / 2);
      masks[cell] = (masks[cell] ?? 0) | (dots[y]?.[x % 2] ?? 0);
      lights[cell] = Math.max(
        lights[cell] ?? 0,
        [1, 0.48, 0.2, 0.08][tail] ?? 0,
      );
    }
  }
  const cells: Cell[] = masks.map((mask, i) => ({
    text: moving && mask ? String.fromCharCode(0x2800 + mask) : " ",
    color: mixColor(palette.surface, color, lights[i] ?? 0),
  }));
  const middle = cells[1];
  if (middle) {
    middle.text =
      t < 0.38 && previous
        ? previous
        : t < 0.6 && previous
          ? "·"
          : activity.icon;
    const fade =
      previous && t < 1
        ? Math.max(0.28, Math.abs(t - 0.45) * 1.8)
        : 0.76 + beat * 0.24;
    middle.color = mixColor(palette.muted, color, moving ? fade : 1);
  }
  const bracket = mixColor(
    palette.muted,
    color,
    moving ? 0.34 + beat * 0.28 : 0.65,
  );
  return [
    { text: "<", color: bracket },
    ...cells,
    { text: ">", color: bracket },
  ];
}

export function activityFrame({
  activity,
  palette,
  width,
  age = 0,
  elapsedMs = 0,
  enabled = true,
  morph = 1,
  previousIcon,
}: {
  activity: RequestActivity;
  palette: Palette;
  width: number;
  age?: number;
  elapsedMs?: number;
  enabled?: boolean;
  morph?: number;
  previousIcon?: string;
}): StyledText {
  const animate = enabled && activity.moving;
  const cells = emblem(
    { ...activity, moving: animate },
    palette,
    animate ? age : 0,
    animate ? morph : 1,
    animate ? previousIcon : undefined,
  );
  if (width < 34) {
    cells.splice(1, 1);
    cells.splice(2, 1);
  }
  const label = width < 34 ? activity.short : activity.label;
  // Status takes precedence over elapsed time in a very small viewport.
  let timer = width >= 18 ? ` · ${elapsedSeconds(elapsedMs)}` : "";
  if (width - cells.length - 1 - timer.length < Math.min(12, label.length))
    timer = "";
  const available = Math.max(0, width - cells.length - 1 - timer.length);
  const text = terminalLine(label, available);
  const wave = ((age % 2200) / 2200) * (Array.from(text).length + 8) - 4;
  const textColor =
    activity.kind === "stopping"
      ? palette.muted
      : activity.kind === "approval"
        ? palette.yellow
        : activity.kind === "failed"
          ? palette.red
          : palette.text;
  const chunks = [
    ...cells,
    { text: " ", color: textColor },
    ...Array.from(text, (character, column) => ({
      text: character,
      color: animate
        ? mixColor(
            textColor,
            palette.accent,
            Math.max(0, 1 - Math.abs(column - wave) / 2.5) * 0.38,
          )
        : textColor,
    })),
    {
      text: " ".repeat(Math.max(0, available - text.length)),
      color: palette.muted,
    },
    { text: timer, color: palette.muted },
  ];
  return new StyledText(
    chunks
      .flatMap(({ text, color }) =>
        Array.from(text, (character) => ({
          __isChunk: true as const,
          text: character,
          fg: RGBA.fromHex(color),
        })),
      )
      .slice(0, Math.max(1, width)),
  );
}
