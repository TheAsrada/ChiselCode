/** @jsxImportSource @opentui/react */
import {
  RGBA,
  StyledText,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core";
import { useEffectEvent, useLayoutEffect, useRef } from "react";
import type { Palette } from "./appearance.js";
import { COMPACT_LOGO, LOGO_WIDTH, renderLogoRows } from "./logo.js";
import { easeOut, mixColor } from "./motion.js";
import { useMotion } from "./opentui-motion.js";

const INTRO_MS = 512;
export const HANDOFF_MS = 138;
const LOGO = renderLogoRows();
const LEVELS = 12;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function noise(x: number, y: number) {
  const hash = Math.imul(x + 23, 374761393) + Math.imul(y + 41, 668265263);
  return (
    ((Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 16) & 0xffff) / 65536
  );
}

function wave(age: number) {
  return easeOut(age / 74) * (1 - easeOut((age - 86) / 202));
}

function introFrame(
  width: number,
  height: number,
  ms: number,
  palette: Palette,
) {
  const full = width >= LOGO_WIDTH + 14 && height >= 16;
  const art = full
    ? LOGO
    : width >= 42 && height >= 10
      ? COMPACT_LOGO
      : ["<i> ChiselCode"];
  const artWidth = Math.max(...art.map((line) => line.length));
  const left = Math.floor((width - artWidth) / 2);
  const top = Math.floor((height - art.length) / 2);
  const gutter = full ? Math.min(27, Math.floor(width * 0.2)) : 7;
  const outgoing = clamp((ms - 400) / 140);
  const fade = 1 - outgoing * outgoing * (3 - 2 * outgoing);
  const bands = [palette.accent, palette.text].map((ink) =>
    Array.from({ length: LEVELS + 1 }, (_, level) =>
      RGBA.fromHex(mixColor(palette.bg, ink, level / LEVELS)),
    ),
  );
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
      const inside =
        artY >= 0 && artY < art.length && artX >= 0 && artX < artWidth;
      const glyph = inside ? art[artY]?.[artX] : undefined;
      if (glyph && glyph !== " ") {
        const heading = artX / artWidth;
        const delay =
          80 + artY * 18 + heading * 107 + Math.sin(heading * 8) * 20;
        const ink = full && artX < 15 ? 0 : 1;
        const level = Math.round(LEVELS * easeOut((ms - delay) / 138) * fade);
        push(level ? glyph : " ", level ? bands[ink]?.[level] : undefined);
        continue;
      }

      const right = x >= width / 2;
      const edge = right ? width - x - 1 : x;
      const fromBottom = height - y - 1;
      const side = clamp(1 - edge / gutter);
      const corner = vertical > 0.72 || vertical < 0.15;
      const density = full
        ? side ** 1.6 * (0.15 + vertical ** 2 * 0.46) +
          (fromBottom < 3 ? 0.055 : 0)
        : corner
          ? side ** 1.8 * 0.34
          : 0;
      const seed = noise(x, y);
      if (inside || seed >= density) {
        push(" ");
        continue;
      }
      const scatter = noise(y, x + 19);
      const arrival =
        vertical * 134 + edge * 3.2 + (right ? 45 : 0) + scatter * 48;
      const brightness = wave(ms - arrival) * (0.3 + 0.56 * scatter) * fade;
      const level = Math.round(LEVELS * brightness);
      push(
        level ? (scatter > 0.72 ? "█" : scatter > 0.33 ? "▄" : "▀") : " ",
        level ? bands[0]?.[level] : undefined,
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
    const paint = (now: number) => {
      const elapsed = now - (start.current ?? now);
      if (elapsed >= INTRO_MS) {
        finish();
        return false;
      }
      if (node.current && !node.current.isDestroyed)
        node.current.content = introFrame(width, height, elapsed, palette);
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
