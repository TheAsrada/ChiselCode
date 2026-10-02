/** @jsxImportSource @opentui/react */
import type { Palette } from "./appearance.js";
import { terminalSafeText } from "./terminal-text.js";

export function ContextCompactionMessage({
  text,
  palette,
}: {
  text: string;
  palette: Palette;
}) {
  const [title, ...details] = terminalSafeText(text, 2000).split("\n");
  return (
    <box width="100%" flexDirection="row" backgroundColor={palette.surface}>
      <box width={1} flexShrink={0} backgroundColor={palette.accent} />
      <box
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={palette.accent} selectable>
          {title}
        </text>
        {details.length > 0 && (
          <text fg={palette.muted} selectable>
            {details.join("\n")}
          </text>
        )}
      </box>
    </box>
  );
}
