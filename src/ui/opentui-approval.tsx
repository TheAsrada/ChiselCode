/** @jsxImportSource @opentui/react */

import type { ApprovalRequest } from "../security/approval.js";
import { type Palette, THEMES } from "./appearance.js";
import { diffViewForWidth, terminalSafeText } from "./opentui-transcript.js";

/** A modal decision surface with its own bounded, scrollable preview. */
export function OpenTuiApproval({
  request,
  width,
  height,
  palette = THEMES.obsidian,
}: {
  request: ApprovalRequest;
  width: number;
  height: number;
  palette?: Palette;
}) {
  const diff = request.fileDiff;
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={palette.bg}
    >
      <text fg={palette.yellow}>
        ? {terminalSafeText(request.tool, 80)} · требуется разрешение
      </text>
      {height >= 5 && (
        <scrollbox height={Math.max(1, height - 3)} viewportCulling>
          {diff ? (
            <box width="100%" flexDirection="column">
              <text fg={palette.muted}>
                {terminalSafeText(diff.path, 180)} · +{diff.additions} −
                {diff.deletions}
              </text>
              <diff
                diff={terminalSafeText(diff.patch)}
                view={diffViewForWidth(width - 2)}
                height={Math.max(
                  1,
                  Math.min(200, diff.patch.split("\n").length),
                )}
                showLineNumbers
              />
            </box>
          ) : (
            <text fg={palette.text} selectable>
              {terminalSafeText(request.preview, 100_000)}
            </text>
          )}
        </scrollbox>
      )}
      <text fg={palette.yellow}>[y/н] Разрешить · [n/т/Esc] Отклонить</text>
    </box>
  );
}
