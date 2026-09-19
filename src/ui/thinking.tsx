import { Text } from "ink";
import { useEffect, useState } from "react";
import { formatDuration } from "./theme.js";

/**
 * Кадры спиннера — кружки из Geometric Shapes (есть в любом шрифте консоли).
 * Брайль U+2800 специально не используем: в шрифтах conhost его нет
 * и вместо анимации видны квадратики-тофу.
 */
const FRAMES = ["◐", "◑", "◒", "◓"];

/** Анимированный индикатор «помощник думает» с секундомером. Одна строка. */
export function Thinking({ model }: { model: string }): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
      setElapsed(Date.now() - started);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color="yellow">
      {FRAMES[frame] ?? "…"} Думаю {formatDuration(elapsed)} ·{" "}
      <Text dimColor>{model}</Text>
    </Text>
  );
}
