/** @jsxImportSource @opentui/react */
import {
  RGBA,
  StyledText,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core";
import { useEffectEvent, useLayoutEffect, useRef } from "react";
import { type Palette, THEMES } from "./appearance.js";
import { COMPACT_LOGO, LOGO_WIDTH, renderLogoRows } from "./logo.js";
import { easeOut, mixColor } from "./motion.js";
import { useMotion } from "./opentui-motion.js";

const INTRO_MS = 512;
export const HANDOFF_MS = 138;
const LOGO = renderLogoRows();
const LEVELS = 12;
const HUE_STEPS = 24;
const ACCENTS = [
  THEMES.obsidian.accent,
  THEMES.graphite.accent,
  THEMES.paper.accent,
  THEMES.ember.accent,
  THEMES.monochrome.accent,
];

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (progress: number) => {
  const t = clamp(progress);
  return t * t * (3 - 2 * t);
};

function noise(x: number, y: number) {
  const hash = Math.imul(x + 23, 374761393) + Math.imul(y + 41, 668265263);
  return (
    ((Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 16) & 0xffff) / 65536
  );
}

function wave(age: number) {
  return easeOut(age / 74) * (1 - easeOut((age - 86) / 214));
}

function inkRamp(palette: Palette) {
  const accents = [
    palette.accent,
    ...ACCENTS.map((accent) =>
      mixColor(accent, palette.text, palette.variant === "light" ? 0.64 : 0.18),
    ),
    palette.text,
  ];
  const colours = Array.from({ length: HUE_STEPS + 1 }, (_, index) => {
    const offset = (index / HUE_STEPS) * (accents.length - 1);
    const first = Math.floor(offset);
    const from = accents[first] ?? palette.text;
    const hue = mixColor(from, accents[first + 1] ?? from, offset - first);
    return Array.from({ length: LEVELS + 1 }, (_, level) =>
      RGBA.fromHex(mixColor(palette.bg, hue, level / LEVELS)),
    );
  });
  return (hue: number, level: number) =>
    colours[Math.round(HUE_STEPS * clamp(hue))]?.[level];
}

function introLayout(width: number, height: number) {
  const full = width >= LOGO_WIDTH + 14 && height >= 16;
  const art = full
    ? LOGO
    : width >= 42 && height >= 10
      ? COMPACT_LOGO
      : ["<i> ChiselCode"];
  const artWidth = Math.max(...art.map((line) => line.length));
  const left = Math.floor((width - artWidth) / 2);
  const top = Math.floor((height - art.length) / 2);

  // The burst starts in the actual strokes. A fixed seed keeps the trajectories
  // coherent between frames and preserves the splash phase through a resize.
  const particles = art.flatMap((line, y) =>
    [...line].flatMap((glyph, x) => {
      const seed = noise(x + 28, y + 53);
      if (glyph === " " || seed > (full ? 0.82 : 0.39) || height < 10)
        return [];
      const variation = noise(y + 31, x + 17);
      const angle = 2 * Math.PI * noise(x + 73, y + 32);
      const reach = full ? 10 + 18 * variation : 3 + 6 * variation;
      return [
        {
          x: left + x,
          y: top + y,
          dx: Math.cos(angle) * reach,
          dy: Math.sin(angle) * reach * 0.55,
          launch: 140 + (x / artWidth) * 70 + y * 7 + seed * 48,
          duration: 152 + variation * 97,
          hue: variation * 0.42,
          glyph: seed > 0.59 ? "█" : seed > 0.3 ? "▄" : "▀",
        },
      ];
    }),
  );
  return { width, height, full, art, artWidth, left, top, particles };
}

function introFrame(
  layout: ReturnType<typeof introLayout>,
  ms: number,
  ink: ReturnType<typeof inkRamp>,
) {
  const { width, height, full, art, artWidth, left, top, particles } = layout;
  const fade = 1 - smooth((ms - 398) / 145);
  const gutter = full ? Math.min(29, Math.floor(width * 0.23)) : 7;
  const burst = new Map<
    number,
    { glyph: string; hue: number; level: number }
  >();
  for (const particle of particles) {
    const progress = (ms - particle.launch) / particle.duration;
    if (progress <= 0 || progress >= 1) continue;
    const travel = easeOut(progress);
    const x = Math.round(particle.x + particle.dx * travel);
    const y = Math.round(particle.y + particle.dy * travel);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const bright = smooth(progress / 0.24) * (1 - progress) ** 0.8 * fade;
    const level = Math.round(LEVELS * bright);
    const cell = y * width + x;
    if (level > (burst.get(cell)?.level ?? 0))
      burst.set(cell, {
        glyph: particle.glyph,
        hue: particle.hue + progress * 0.57,
        level,
      });
  }

  const chunks: TextChunk[] = [];
  let run = "";
  let previous: RGBA | undefined;
  const push = (text: string, color?: RGBA) => {
    if (previous !== color && run) {
      chunks.push({ __isChunk: true, text: run, fg: previous });
      run = "";
    }
    previous = color;
    run += text;
  };

  for (let y = 0; y < height; y++) {
    const vertical = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const artX = x - left;
      const artY = y - top;
      const glyph = art[artY]?.[artX];
      if (glyph && glyph !== " ") {
        const heading = artX / artWidth;
        const delay =
          64 + artY * 17 + heading * 102 + Math.sin(heading * 8) * 19;
        // Let the letters stay sharp while the color travels diagonally through
        // them. The last swatch blends into the current UI's text color.
        const hue = (ms - delay + 32) / 270 + artY * 0.025;
        const level = Math.round(LEVELS * easeOut((ms - delay) / 126) * fade);
        push(level ? glyph : " ", level ? ink(hue, level) : undefined);
        continue;
      }

      const particle = burst.get(y * width + x);
      if (particle) {
        push(particle.glyph, ink(particle.hue, particle.level));
        continue;
      }

      const right = x >= width / 2;
      const edge = right ? width - x - 1 : x;
      const fromBottom = height - y - 1;
      const side = clamp(1 - edge / gutter);
      const corner = vertical > 0.72 || vertical < 0.15;
      const density = full
        ? side ** 1.45 * (0.26 + vertical ** 2 * 0.56) +
          (fromBottom < 3 ? 0.075 : 0)
        : corner
          ? side ** 1.55 * 0.48
          : 0;
      if (noise(x, y) >= density) {
        push(" ");
        continue;
      }
      const scatter = noise(y, x + 19);
      const arrival =
        vertical * 134 + edge * 3.2 + (right ? 45 : 0) + scatter * 48;
      const brightness = wave(ms - arrival) * (0.23 + 0.51 * scatter) * fade;
      const level = Math.round(LEVELS * brightness);
      const hue = (ms + vertical * 72 + scatter * 85) / 535;
      push(
        level ? (scatter > 0.73 ? "█" : scatter > 0.36 ? "▄" : "▀") : " ",
        level ? ink(hue, level) : undefined,
      );
    }
    if (y < height - 1) push("\n");
  }
  if (run) chunks.push({ __isChunk: true, text: run, fg: previous });
  return new StyledText(chunks);
}

export function StartupIntro({
  width,
  height,
  palette,
  onComplete,
}: {
  width: number;
  height: number;
  palette: Palette;
  onComplete(): void;
}) {
  const { clock } = useMotion();
  const node = useRef<TextRenderable>(null);
  const start = useRef<number | undefined>(undefined);
  const finish = useEffectEvent(onComplete);
  useLayoutEffect(() => {
    start.current ??= performance.now();
    const layout = introLayout(width, height);
    const ink = inkRamp(palette);
    const paint = (now: number) => {
      const elapsed = now - (start.current ?? now);
      if (elapsed >= INTRO_MS) {
        finish();
        return false;
      }
      if (node.current && !node.current.isDestroyed)
        node.current.content = introFrame(layout, elapsed, ink);
      return true;
    };
    if (paint(performance.now())) return clock?.add(paint);
  }, [clock, width, height, palette]);
  return (
    <box width={width} height={height} backgroundColor={palette.bg}>
      <text
        id="startup-intro"
        ref={node}
        width={width}
        height={height}
        wrapMode="none"
        selectable={false}
      />
      {width >= 24 && height >= 10 && (
        <text
          position="absolute"
          right={2}
          bottom={1}
          height={1}
          fg={palette.muted}
          selectable={false}
        >
          Esc · пропустить
        </text>
      )}
    </box>
  );
}
