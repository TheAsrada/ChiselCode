/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import type { ApprovalRequest } from "../security/approval.js";
import { type Palette, THEMES } from "./appearance.js";
import { extensionToolLabel } from "./extension-tool.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { FileDiffCard } from "./opentui-file-diff.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";

/** A modal decision surface with its own bounded, scrollable preview. */
export function OpenTuiApproval({
  request,
  width,
  height,
  palette = THEMES.obsidian,
  onApprove = () => {},
  onAlwaysApprove,
  onSessionApprove,
  onDeny = () => {},
}: {
  request: ApprovalRequest;
  width: number;
  height: number;
  palette?: Palette;
  onApprove?: () => void;
  onAlwaysApprove?: () => void;
  onSessionApprove?: () => void;
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
        : request.preview.split("\n").length) +
        7 +
        (request.network ? 1 : 0),
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
        <strong>
          {request.mcp?.destructive
            ? "Подтвердить опасное действие?"
            : request.mcp
              ? request.mcp.serverTitle
              : tiny &&
                  request.source?.type === "extension" &&
                  request.source.extensionId === "builtin.worktrees"
                ? "Рабочая копия"
                : (extensionToolLabel(request.source) ??
                  (request.network
                    ? "Доступ к интернету"
                    : "Разрешить действие?"))}
        </strong>
      </text>
      <text fg={palette.muted} height={1}>
        {terminalSafeText(
          request.mcp?.title ??
            (request.network
              ? request.network.operation === "search"
                ? "Поиск в интернете"
                : "Открытие страницы"
              : request.source?.type === "extension"
                ? request.source.originalName
                : request.tool),
          innerWidth,
        )}
        {diffs.length > 1 ? ` | файлов: ${diffs.length}` : ""}
      </text>
      {popupHeight >= 5 && (
        <TerminalScrollbox
          id="approval-preview"
          ref={preview}
          flexGrow={1}
          minHeight={0}
          viewportCulling
        >
          {diffs.length ? (
            <>
              {request.source?.type === "extension" &&
                request.source.extensionId === "builtin.worktrees" && (
                  <>
                    <text fg={palette.text}>
                      {terminalLine(
                        request.preview.split("\n")[0] ?? "",
                        innerWidth,
                      )}
                    </text>
                    <text fg={palette.muted}>
                      {terminalLine(
                        request.preview
                          .split("\n")
                          .find((line) => line.startsWith("Target origin:")) ??
                          "",
                        innerWidth,
                      )}
                    </text>
                  </>
                )}
              {diffs.map((diff) => (
                <FileDiffCard
                  key={diff.path}
                  id={`approval-diff-${diff.path}`}
                  diff={diff}
                  width={innerWidth}
                  expanded
                  palette={palette}
                />
              ))}
              {request.source?.type === "extension" &&
                request.source.extensionId === "builtin.worktrees" && (
                  <text fg={palette.muted} selectable>
                    {terminalSafeText(request.preview, 4096)}
                  </text>
                )}
            </>
          ) : request.mcp ? (
            <box flexDirection="column" gap={1}>
              <text fg={palette.muted}>
                {request.mcp.serverId}.{request.mcp.originalName}
              </text>
              {request.mcp.fields.map((field) => (
                <box key={field.label} flexDirection="column">
                  <text fg={palette.muted}>
                    {terminalSafeText(field.label)}
                  </text>
                  <text fg={palette.text} selectable>
                    {terminalSafeText(field.value)}
                  </text>
                </box>
              ))}
              <text fg={request.mcp.destructive ? palette.red : palette.yellow}>
                {terminalSafeText(request.mcp.consequence)}
              </text>
            </box>
          ) : (
            <text fg={palette.text} selectable>
              {terminalSafeText(request.preview, 100_000)}
            </text>
          )}
        </TerminalScrollbox>
      )}
      <box flexDirection="row" height={1} gap={1} flexShrink={0}>
        <DialogAction
          id="approval-approve"
          label={
            tiny ? "Y Да" : innerWidth < 48 ? "Разрешить" : "Разрешить один раз"
          }
          onSelect={onApprove}
          palette={palette}
          primary
        />
        <DialogAction
          id="approval-deny"
          label={tiny ? "N Нет" : "Отклонить"}
          onSelect={onDeny}
          palette={palette}
        />
        {request.mcp &&
          !request.mcp.destructive &&
          onAlwaysApprove &&
          innerWidth >= 50 && (
            <DialogAction
              id="approval-always"
              label="Всегда этот tool"
              onSelect={onAlwaysApprove}
              palette={palette}
            />
          )}
      </box>
      {request.network && onSessionApprove && (
        <box height={1} flexShrink={0}>
          <DialogAction
            id="approval-session"
            label={
              request.network.operation === "search"
                ? "Поиск на сессию (A)"
                : "Домен на сессию (A)"
            }
            onSelect={onSessionApprove}
            palette={palette}
          />
        </box>
      )}
      {!tiny && (
        <text height={1} fg={palette.muted}>
          {terminalSafeText(
            request.network
              ? "Y один раз | A на сессию | N / Esc отказ"
              : innerWidth < 48
                ? "Y / Н - да | N / Т / Esc - нет"
                : "Y / Н - один раз | N / Т / Esc - отказ",
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
