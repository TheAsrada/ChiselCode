/** @jsxImportSource @opentui/react */
import type { ApprovalRequest } from "../security/approval.js";
import { diffViewForWidth, terminalSafeText } from "./opentui-transcript.js";

/** A modal decision surface with its own bounded, scrollable preview. */
export function OpenTuiApproval({
  request,
  width,
  height,
}: {
  request: ApprovalRequest;
  width: number;
  height: number;
}) {
  const diff = request.fileDiff;
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor="#201e20"
    >
      <text fg="#e5bf74">
        ? {terminalSafeText(request.tool, 80)} · требуется разрешение
      </text>
      {height >= 5 && (
        <scrollbox height={Math.max(1, height - 3)} viewportCulling>
          {diff ? (
            <box width="100%" flexDirection="column">
              <text fg="#aebbc9">
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
            <text fg="#d6dce5" selectable>
              {terminalSafeText(request.preview, 100_000)}
            </text>
          )}
        </scrollbox>
      )}
      <text fg="#e5bf74">[y/н] Разрешить · [n/т/Esc] Отклонить</text>
    </box>
  );
}
