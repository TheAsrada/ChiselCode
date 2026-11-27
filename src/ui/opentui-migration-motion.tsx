/** @jsxImportSource @opentui/react */
import {
  RGBA,
  StyledText,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core";
import { useLayoutEffect, useRef, useState } from "react";
import type { Palette } from "./appearance.js";
import { mixColor } from "./motion.js";
import { useMotion } from "./opentui-motion.js";

export const MIGRATION_MOTION_MS = 5_000;

const glyphs = ["·", "∙", "∘", "✧", "✦", "◈"];
const spectrum = ["#64edfc", "#75a4ff", "#b397ff", "#fa8edc", "#a4fbe4"];

function waveField(width: number, height: number, palette: Palette) {
  const colours = spectrum.map((hue) =>
    Array.from({ length: 9 }, (_, shade) =>
      RGBA.fromHex(
        mixColor(
          palette.surface,
          palette.variant === "light" ? mixColor(hue, palette.text, 0.66) : hue,
          shade / 8,
        ),
      ),
    ),
  );
  const cells = Array.from({ length: width * height }, (_, i) => {
    const x = (i % width) - (width - 1) / 2;
    const y = (Math.floor(i / width) - (height - 1) / 2) * 2;
    const radius = Math.hypot(x, y);
    const angle = Math.atan2(y, x);
    const seed =
      ((Math.imul((i + 1) ^ (i >>> 5), 0x45d9f3b) >>> 0) % 997) / 997;
    return { radius, angle, seed };
  });
  const maxRadius = Math.hypot(width / 2, height);
  return (progress: number) => {
    const chunks: TextChunk[] = [];
    let blank = "";
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell) break;
      const { radius, angle, seed } = cell;
      const phase =
        (radius / maxRadius) * 2.8 -
        progress * 5.4 +
        Math.sin(angle * 5 - progress * 8) * 0.21 +
        Math.sin(angle * 9 + progress * 6) * 0.075;
      const wave = (0.5 + 0.5 * Math.cos(phase * Math.PI * 2)) ** 7;
      const tendrils =
        (0.5 + 0.5 * Math.cos(angle * 7 + radius / 8 - progress * 7)) ** 5;
      const arrival = Math.max(
        0,
        Math.min(1, (progress * 2.6 - radius / maxRadius) * 8),
      );
      const fade = Math.min(1, (1 - progress) * 7);
      const glow =
        arrival *
        fade *
        (wave * (0.34 + seed * 0.66) +
          tendrils * seed * 0.25 +
          (seed > 0.985 ? 0.24 : 0));
      const shade = Math.min(8, Math.round(glow * 8));
      if (shade < 2 || (seed < 0.19 && shade < 6)) blank += " ";
      else {
        if (blank) chunks.push({ __isChunk: true, text: blank });
        blank = "";
        const hue =
          Math.floor(
            ((radius / maxRadius) * 4 +
              (angle + Math.PI) * 0.25 +
              10 -
              progress * 6) *
              2,
          ) % colours.length;
        chunks.push({
          __isChunk: true,
          text: glyphs[Math.min(glyphs.length - 1, shade - 2)] ?? "·",
          fg: colours[hue]?.[shade],
        });
      }
      if (i % width === width - 1 && i < cells.length - 1) blank += "\n";
    }
    if (blank) chunks.push({ __isChunk: true, text: blank });
    return new StyledText(chunks);
  };
}

export function MigrationMotion({
  started,
  width,
  height,
  palette,
}: {
  started: number;
  width: number;
  height: number;
  palette: Palette;
}) {
  const { clock } = useMotion();
  const field = useRef<TextRenderable>(null);
  const [percent, setPercent] = useState(0);
  useLayoutEffect(() => {
    const renderable = field.current;
    if (!renderable || !clock) return;
    const paintField =
      width >= 30 && height >= 8
        ? waveField(width, height, palette)
        : undefined;
    const draw = (now: number) => {
      const progress = Math.min(
        1,
        Math.max(0, (now - started) / MIGRATION_MOTION_MS),
      );
      if (renderable.isDestroyed) return false;
      if (paintField) renderable.content = paintField(progress);
      setPercent(Math.round(progress * 100));
      return progress < 1;
    };
    draw(performance.now());
    return clock.add(draw);
  }, [clock, height, width, palette, started]);
  const barWidth = Math.min(19, Math.max(1, width - 4));
  const fill = Math.round((percent * barWidth) / 100);
  return (
    <box
      flexGrow={1}
      overflow="hidden"
      alignItems="center"
      justifyContent="center"
    >
      <text
        ref={field}
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        wrapMode="none"
        selectable={false}
      />
      <box
        backgroundColor={palette.surface}
        paddingLeft={2}
        paddingRight={2}
        alignItems="center"
      >
        {height >= 4 && (
          <text fg={palette.muted} selectable={false}>
            Перенос данных
          </text>
        )}
        <text fg={palette.text} selectable={false}>
          <b>{percent}%</b>
        </text>
        {height >= 4 && (
          <text selectable={false} fg={palette.accent}>
            {"━".repeat(fill)}
            <span fg={palette.border}>{"─".repeat(barWidth - fill)}</span>
          </text>
        )}
      </box>
    </box>
  );
}
