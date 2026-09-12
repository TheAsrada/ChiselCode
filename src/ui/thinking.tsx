import { Text } from "ink";
import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Анимированный индикатор «помощник думает» с секундомером. */
export function Thinking({ model }: { model: string }): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color="yellow">
      {FRAMES[frame] ?? "…"} Думаю{seconds > 0 ? ` ${seconds}с` : ""} ·{" "}
      <Text dimColor>{model}</Text>
    </Text>
  );
}
