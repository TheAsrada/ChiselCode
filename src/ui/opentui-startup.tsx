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

const INTRO_MS = 3200;
export const HANDOFF_MS = 300;
const PROMPT = "Press any key";
const LOGO = renderLogoRows();
const LEVELS = 24;
const HUE_STEPS = 36;
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
  const first = smooth(age / 365) * (1 - smooth((age - 530) / 915));
  const echo = smooth((age - 1160) / 360) * (1 - smooth((age - 1580) / 770));
  return first + echo * 0.36;
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
  const top = Math.max(0, Math.floor((height - art.length - 2) / 2));
  const promptX = Math.max(0, Math.floor((width - PROMPT.length) / 2));
  const promptY = Math.min(height - 1, top + art.length + 1);

  // The burst starts in the actual strokes. A fixed seed keeps the trajectories
  // coherent between frames and preserves the splash phase through a resize.
  const particles = art.flatMap((line, y) =>
    [...line].flatMap((glyph, x) => {
      const seed = noise(x + 28, y + 53);
      if (glyph === " " || seed > (full ? 0.82 : 0.39) || height < 10)
        return [];
      const variation = noise(y + 31, x + 17);
      const angle = 2 * Math.PI * noise(x + 73, y + 32);
      const reach = full ? 13 + 24 * variation : 3 + 7 * variation;
      return [
        {
          x: left + x,
          y: top + y,
          dx: Math.cos(angle) * reach,
          dy: Math.sin(angle) * reach * 0.55,
          launch: 910 + (x / artWidth) * 435 + y * 36 + seed * 270,
          duration: 1040 + variation * 430,
          hue: variation * 0.42,
          glyph: seed > 0.59 ? "█" : seed > 0.3 ? "▄" : "▀",
        },
      ];
    }),
  );
  const driftCount = Math.min(full ? 85 : 20, Math.ceil((width * height) / 66));
  const drifting = Array.from({ length: driftCount }, (_, i) => {
    const seed = noise(i, 31);
    const period = 3600 + noise(i, 51) * 2600;
    return {
      x: noise(i, 19) * (width - 1),
      y: noise(i, 29) * (height - 1),
      dx: (seed - 0.5) * (full ? 30 : 16),
      dy: 3 + noise(i, 39) * (full ? 11 : 5),
      period,
      offset: noise(i, 61) * period,
      hue: 0.19 + seed * 0.6,
      glyph: seed > 0.67 ? "█" : seed > 0.33 ? "▄" : "▀",
    };
  });
  return {
    width,
    height,
    full,
    art,
    artWidth,
    left,
    top,
    promptX,
    promptY,
    particles,
    drifting,
  };
}

function introFrame(
  layout: ReturnType<typeof introLayout>,
  ms: number,
  ink: ReturnType<typeof inkRamp>,
  animated: boolean,
) {
  const { width, height, full, art, artWidth, left, top, promptX, promptY } =
    layout;
  const waiting = ms >= INTRO_MS;
  const fade = animated ? 1 - smooth((ms - 2480) / 805) : 0;
  const gutter = full ? Math.min(29, Math.floor(width * 0.23)) : 7;
  const particles = new Map<
    number,
    { glyph: string; hue: number; level: number }
  >();
  const addParticle = (
    col: number,
    row: number,
    glyph: string,
    hue: number,
    brightness: number,
  ) => {
    const x = Math.round(col);
    const y = Math.round(row);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const level = Math.round(LEVELS * brightness);
    const cell = y * width + x;
    if (level > (particles.get(cell)?.level ?? 0))
      particles.set(cell, { glyph, hue, level });
  };
  if (fade > 0) {
    for (const particle of layout.particles) {
      const progress = (ms - particle.launch) / particle.duration;
      if (progress <= 0 || progress >= 1) continue;
      const travel = 1 - (1 - progress) ** 2;
      addParticle(
        particle.x + particle.dx * travel,
        particle.y + particle.dy * travel,
        particle.glyph,
        particle.hue + progress * 0.57,
        smooth(progress / 0.28) * (1 - progress) ** 0.85 * fade,
      );
    }
  }
  const driftOpacity = animated ? smooth((ms - 2730) / 640) : 0;
  if (driftOpacity > 0) {
    for (const particle of layout.drifting) {
      const phase =
        ((ms + particle.offset) % particle.period) / particle.period;
      addParticle(
        particle.x + particle.dx * (phase - 0.5),
        particle.y - particle.dy * (phase - 0.5),
        particle.glyph,
        particle.hue,
        Math.sin(phase * Math.PI) ** 2 * (full ? 0.45 : 0.52) * driftOpacity,
      );
    }
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
      const promptColumn = x - promptX;
      const promptGlyph =
        waiting && y === promptY ? PROMPT[promptColumn] : undefined;
      if (promptGlyph) {
        const shine =
          (1 + Math.cos((ms - INTRO_MS) / 380 - promptColumn * 0.4)) / 2;
        const level = animated
          ? Math.round(LEVELS * (0.76 + 0.24 * shine))
          : LEVELS;
        push(promptGlyph, ink(1, level));
        continue;
      }
      const artX = x - left;
      const artY = y - top;
      const glyph = art[artY]?.[artX];
      if (glyph && glyph !== " ") {
        const heading = artX / artWidth;
        const delay =
          350 + artY * 67 + heading * 420 + Math.sin(heading * 8) * 74;
        // Let the letters stay sharp while the color travels diagonally through
        // them. The last swatch blends into the current UI's text color.
        const hue = (ms - delay + 120) / 1640 + artY * 0.018;
        const level = animated
          ? Math.round(
              LEVELS * easeOut((ms - delay) / 625) * (0.92 + 0.08 * fade),
            )
          : LEVELS;
        push(level ? glyph : " ", level ? ink(hue, level) : undefined);
        continue;
      }

      const particle = particles.get(y * width + x);
      if (particle) {
        push(particle.glyph, ink(particle.hue, particle.level));
        continue;
      }
      if (fade === 0) {
        push(" ");
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
        vertical * 730 + edge * 17 + (right ? 200 : 0) + scatter * 210;
      const brightness = wave(ms - arrival) * (0.23 + 0.51 * scatter) * fade;
      const level = Math.round(LEVELS * brightness);
      const hue = (ms + vertical * 290 + scatter * 370) / 2800;
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
  onReady,
}: {
  width: number;
  height: number;
  palette: Palette;
  onReady(): void;
}) {
  const { clock, enabled } = useMotion();
  const node = useRef<TextRenderable>(null);
  const start = useRef<number | undefined>(undefined);
  const promptVisible = useRef(false);
  const showPrompt = useEffectEvent(onReady);
  useLayoutEffect(() => {
    const renderable = node.current;
    if (!renderable) return;
    start.current ??= performance.now();
    const layout = introLayout(width, height);
    const ink = inkRamp(palette);
    if (!enabled || !clock) {
      renderable.content = introFrame(layout, INTRO_MS, ink, false);
      return;
    }
    const paint = (now: number) => {
      const elapsed = now - (start.current ?? now);
      if (renderable.isDestroyed) return false;
      renderable.content = introFrame(layout, elapsed, ink, true);
      if (elapsed >= INTRO_MS && !promptVisible.current) {
        promptVisible.current = true;
        showPrompt();
      }
      return true;
    };
    if (paint(performance.now())) return clock.add(paint);
  }, [clock, enabled, width, height, palette]);
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
    </box>
  );
}
