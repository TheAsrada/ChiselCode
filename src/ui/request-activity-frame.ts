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
type Spark = { x: number; y: number; light: number };

function sparks(kind: RequestActivity["kind"], age: number): Spark[] {
  switch (kind) {
    case "thinking": {
      const angle = (age / 1800) * Math.PI * 2;
      const x = Math.cos(angle) * 2.5;
      const y = Math.sin(angle) * 1.45;
      return [
        { x: 2.5 + x, y: 1.5 + y, light: 1 },
        { x: 2.5 - x, y: 1.5 - y, light: 0.6 },
      ];
    }
    case "model_tool": {
      const travel = easeOut(Math.min(1, (age % 1600) / 680));
      return [
        { x: 2.5 * travel, y: travel, light: 1 - travel },
        { x: 5 - 2.5 * travel, y: 3 - travel, light: 1 - travel },
      ];
    }
    case "reading":
    case "searching":
    case "checking": {
      const y = Math.sin((age / 1500) * Math.PI * 2) * 1.5 + 1.5;
      return [
        { x: 0, y, light: 0.55 },
        { x: 1, y, light: 0.9 },
        { x: 4, y, light: 0.9 },
        { x: 5, y, light: 0.55 },
      ];
    }
    case "editing": {
      const stroke = Math.min(1, age / 560);
      return [
        { x: 5 * stroke, y: 3 * (1 - stroke), light: 1 - stroke },
        { x: Math.max(0, 5 * stroke - 1), y: 3, light: (1 - stroke) * 0.5 },
      ];
    }
    case "continuing": {
      const travel = easeOut(Math.min(1, age / 420));
      return [
        { x: 2.5 * travel, y: 2, light: 1 - travel },
        { x: 5 - 2.5 * travel, y: 2, light: 1 - travel },
      ];
    }
    case "answering":
    case "command":
      return [];
    default: {
      const position = (age % 1450) / 1450;
      const x = position * 7 - 1;
      return [
        { x, y: 1, light: Math.sin(position * Math.PI) },
        { x: x - 1, y: 2, light: Math.sin(position * Math.PI) * 0.45 },
      ];
    }
  }
}

/** Five fixed terminal cells; the outer cells trace motion around a persistent icon. */
function emblem(
  activity: RequestActivity,
  palette: Palette,
  age: number,
  morph: number,
  previous?: string,
): Cell[] {
  const color =
    activity.kind === "approval"
      ? palette.yellow
      : activity.kind === "failed"
        ? palette.red
        : activity.kind === "stopping"
          ? palette.muted
          : palette.accent;
  const period = activity.kind === "answering" ? 1700 : 1250;
  const beat = activity.moving
    ? (1 - Math.cos((age / period) * Math.PI * 2)) / 2
    : 1;
  const intensity = activity.moving ? 0.55 + beat * 0.45 : 1;
  const masks = [0, 0, 0];
  const lights = [0, 0, 0];
  if (activity.moving) {
    for (const spark of sparks(activity.kind, age)) {
      const x = Math.round(spark.x);
      const y = Math.round(spark.y);
      if (spark.light <= 0 || x < 0 || x > 5) continue;
      const cell = Math.floor(x / 2);
      masks[cell] = (masks[cell] ?? 0) | (dots[y]?.[x % 2] ?? 0);
      lights[cell] = Math.max(lights[cell] ?? 0, spark.light);
    }
  }
  const trail = (index: number): Cell => ({
    text: masks[index]
      ? String.fromCharCode(0x2800 + (masks[index] ?? 0))
      : " ",
    color: mixColor(palette.surface, color, lights[index] ?? 0),
  });
  const bracket = mixColor(palette.muted, color, 0.35 + beat * 0.23);
  const icon = activityCenterIcon(activity.icon, morph, previous);
  const center = Math.max(intensity, (lights[1] ?? 0) * 0.82);
  const fade = previous && morph < 1 ? 0.5 + 0.5 * Math.abs(2 * morph - 1) : 1;
  return [
    { text: "<", color: bracket },
    trail(0),
    { text: icon, color: mixColor(palette.muted, color, center * fade) },
    trail(2),
    { text: ">", color: bracket },
  ];
}

export function activityCenterIcon(
  icon: string,
  morph: number,
  previous?: string,
): string {
  if (!previous || morph >= 0.6) return icon;
  return morph < 0.38 ? previous : "·";
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
    { text, color: textColor },
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
