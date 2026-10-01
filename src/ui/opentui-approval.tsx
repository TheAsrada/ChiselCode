/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import type { ApprovalRequest } from "../security/approval.js";
import { type Palette, THEMES } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { diffViewForWidth, terminalSafeText } from "./opentui-transcript.js";

/** A modal decision surface with its own bounded, scrollable preview. */
export function OpenTuiApproval({
  request,
  width,
  height,
  palette = THEMES.obsidian,
  onApprove = () => {},
  onDeny = () => {},
}: {
  request: ApprovalRequest;
  width: number;
  height: number;
  palette?: Palette;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const diffs = request.diffs ?? (request.fileDiff ? [request.fileDiff] : []);
  const maxHeight = Math.min(
    22,
    Math.max(
      10,
      (diffs.length
        ? diffs.reduce(
            (rows, diff) => rows + diff.patch.split("\n").length + 1,
            0,
          )
        : request.preview.split("\n").length) + 7,
    ),
  );
  const { innerWidth, popupHeight, tiny } = dialogLayout(
    width,
    height,
    maxHeight,
  );
  const preview = useRef<ScrollBoxRenderable>(null);
  useKeyboard((key) => {
    const box = preview.current;
    if (!box) return;
    if (key.name === "up" || key.name === "down")
      box.scrollBy(key.name === "up" ? -1 : 1);
    if (key.name === "pageup" || key.name === "pagedown")
      box.scrollBy(
        (key.name === "pageup" ? -1 : 1) * Math.max(1, box.viewport.height - 1),
      );
    if (key.name === "home") box.scrollTo(0);
    if (key.name === "end") box.scrollTo(Number.MAX_SAFE_INTEGER);
  });
  return (
    <OpenTuiDialog
      id="approval"
      width={width}
      height={height}
      maxHeight={maxHeight}
      palette={palette}
      onClose={onDeny}
    >
      <text fg={palette.yellow} height={1}>
        <strong>Разрешить действие?</strong>
      </text>
      <text fg={palette.muted} height={1}>
        {terminalSafeText(request.tool, innerWidth)}
        {diffs.length > 1 ? ` · файлов: ${diffs.length}` : ""}
      </text>
      {popupHeight >= 5 && (
        <scrollbox
          id="approval-preview"
          ref={preview}
          flexGrow={1}
          minHeight={0}
          viewportCulling
        >
          {diffs.length ? (
            diffs.map((diff) => (
              <box
                key={diff.path}
                width="100%"
                flexDirection="column"
                flexShrink={0}
              >
                <text fg={palette.muted}>
                  {terminalSafeText(diff.path, 180)} · +{diff.additions} −
                  {diff.deletions}
                </text>
                <diff
                  diff={terminalSafeText(diff.patch)}
                  view={diffViewForWidth(innerWidth)}
                  showLineNumbers
                />
              </box>
            ))
          ) : (
            <text fg={palette.text} selectable>
              {terminalSafeText(request.preview, 100_000)}
            </text>
          )}
        </scrollbox>
      )}
      <box flexDirection="row" height={1} gap={1} flexShrink={0}>
        <DialogAction
          id="approval-approve"
          label={tiny || innerWidth < 48 ? "Разрешить" : "Разрешить один раз"}
          onSelect={onApprove}
          palette={palette}
          primary
        />
        <DialogAction
          id="approval-deny"
          label="Отклонить"
          onSelect={onDeny}
          palette={palette}
        />
      </box>
      {!tiny && (
        <text height={1} fg={palette.muted}>
          {terminalSafeText(
            innerWidth < 48
              ? "Y / Н — да · N / Т / Esc — нет"
              : "Y / Н — один раз · N / Т / Esc — отказ",
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
