/** @jsxImportSource @opentui/react */
import { useEffect, useState } from "react";
import type { Palette } from "./appearance.js";
import { elapsedSeconds } from "./request-timing.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController } from "./tui-controller.js";

/** Only this small row ticks; response Markdown and the editor stay mounted. */
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
  const [, tick] = useState(0);
  const startedAt = controller.snapshot.requestStartedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return null;
  return (
    <box width="100%" height={1} flexShrink={0} paddingLeft={1}>
      <text id="request-status" fg={palette.muted} height={1}>
        {terminalLine(
          `${awaitingApproval ? "Ожидаю подтверждения" : "Думаю"} · ${elapsedSeconds(controller.requestElapsedMs)}`,
          Math.max(1, width - 1),
        )}
      </text>
    </box>
  );
}
