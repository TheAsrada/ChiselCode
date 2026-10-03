/** @jsxImportSource @opentui/react */
import {
  CodeRenderable,
  type DiffRenderable,
  SyntaxStyle,
} from "@opentui/core";
import { useEffect, useMemo } from "react";
import type { FileDiff } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import { diffLinePrefix } from "./file-diff-model.js";
import {
  diffAction,
  diffColors,
  diffFiletype,
  diffPathLabel,
  diffPreview,
  diffViewForWidth,
  emptyDiffMessage,
  hiddenDiffChanges,
} from "./file-diff-preview.js";
import { useTerminalDecoration } from "./terminal-decoration.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

/** OpenTUI 0.5's percentage code width includes the gutter in its measurement.
 * Fit the public child layout to the remaining cells and actual wrapped rows,
 * avoiding a blank tail and code drawn over the card's right border. */
const fittedCode = new WeakSet<CodeRenderable>();
function fitNativeDiff(this: DiffRenderable) {
  if (this.isDestroyed) return;
  let rows = 0;
  for (const side of this.getChildren()) {
    const children = side.getChildren();
    const code = children.find((child) => child instanceof CodeRenderable);
    if (!(code instanceof CodeRenderable) || side.width < 1) continue;
    if (!fittedCode.has(code)) {
      fittedCode.add(code);
      code.on("line-info-change", () => fitNativeDiff.call(this));
      code.onSizeChange = () => fitNativeDiff.call(this);
    }
    const gutter = children.reduce(
      (width, child) => width + (child === code ? 0 : child.width),
      0,
    );
    const width = Math.max(1, side.width - gutter);
    if (code.width !== width) code.width = width;
    rows = Math.max(rows, code.virtualLineCount);
  }
  if (rows && this.height !== rows) this.height = rows;
}

/** Native line wrapping and source selection; full patches are never height-capped. */
export function ThemedFileDiff({
  diff,
  id,
  width,
  palette,
}: {
  diff: FileDiff;
  id?: string;
  width: number;
  palette: Palette;
}) {
  const { text, accent, green, yellow, muted } = palette;
  const syntaxStyle = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        default: { fg: text },
        variable: { fg: text },
        punctuation: { fg: muted },
        keyword: { fg: accent },
        operator: { fg: accent },
        string: { fg: green },
        comment: { fg: muted },
        number: { fg: yellow },
        boolean: { fg: yellow },
        constant: { fg: yellow },
        function: { fg: accent },
        type: { fg: yellow },
        property: { fg: text },
      }),
    [text, accent, green, yellow, muted],
  );
  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);
  return (
    <diff
      id={id}
      diff={terminalSafeText(diff.patch, diff.patch.length)}
      width="100%"
      view={diffViewForWidth(width)}
      filetype={diffFiletype(diff.path)}
      syntaxStyle={syntaxStyle}
      wrapMode="word"
      showLineNumbers
      onSizeChange={fitNativeDiff}
      renderAfter={fitNativeDiff}
      {...diffColors(palette)}
    />
  );
}

export function FileDiffCard({
  diff,
  id,
  width,
  expanded = false,
  latest = false,
  onToggle,
  palette = THEMES.obsidian,
}: {
  diff: FileDiff;
  id: string;
  width: number;
  expanded?: boolean;
  latest?: boolean;
  onToggle?: () => void;
  palette?: Palette;
}) {
  const { borderChars } = useTerminalDecoration();
  const preview = diffPreview(diff);
  const colors = diffColors(palette);
  const innerWidth = Math.max(1, width - 2);
  const wide = innerWidth >= 55;
  const statsWidth =
    String(diff.additions).length + String(diff.deletions).length + 4;
  const actionWidth = diffAction(diff).length + 2;
  const pathWidth = Math.max(
    1,
    innerWidth - 2 - statsWidth - (wide ? actionWidth : 0),
  );
  const actionColor =
    diff.kind === "create"
      ? palette.green
      : diff.kind === "delete"
        ? palette.red
        : palette.accent;
  const footer = [
    onToggle ? (expanded ? "Свернуть" : "Развернуть") : "Полный дифф",
    !expanded && preview.hiddenChanges
      ? hiddenDiffChanges(preview.hiddenChanges)
      : "",
    latest ? "Ctrl+D" : "",
  ]
    .filter(Boolean)
    .join("  |  ");
  return (
    <box
      id={id}
      width="100%"
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      customBorderChars={borderChars}
      borderColor={palette.border}
      backgroundColor={palette.surface}
      marginTop={1}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+D toggles the latest card. */}
      <box
        id={`${id}-toggle`}
        width="100%"
        flexDirection="row"
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={palette.raised}
        onMouseUp={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          onToggle?.();
        }}
      >
        <text fg={palette.text} height={1} flexGrow={1} selectable={false}>
          <strong>{diffPathLabel(diff.path, pathWidth)}</strong>
        </text>
        {wide && (
          <text
            fg={actionColor}
            height={1}
            width={actionWidth}
            selectable={false}
          >
            {diffAction(diff)}{" "}
          </text>
        )}
        <text height={1} width={statsWidth} selectable={false}>
          <span fg={palette.green}>+{diff.additions}</span>
          {"  "}
          <span fg={palette.red}>-{diff.deletions}</span>
        </text>
      </box>
      {expanded &&
        diff.kind === "edit" &&
        diffViewForWidth(innerWidth) === "split" && (
          <box height={1} width="100%" flexDirection="row">
            <text width="50%" height={1} fg={palette.muted} selectable={false}>
              {" "}
              Было
            </text>
            <text width="50%" height={1} fg={palette.muted} selectable={false}>
              {" "}
              Стало
            </text>
          </box>
        )}
      {expanded && preview.error ? (
        <text fg={palette.muted} selectable>
          {terminalSafeText(diff.patch, diff.patch.length)}
        </text>
      ) : expanded && preview.lines.length ? (
        <ThemedFileDiff
          id={`${id}-full`}
          diff={diff}
          width={innerWidth}
          palette={palette}
        />
      ) : preview.lines.length ? (
        preview.lines.map((line) => {
          const change = line.kind === "add" || line.kind === "remove";
          const tone =
            line.kind === "add"
              ? palette.green
              : line.kind === "remove"
                ? palette.red
                : palette.muted;
          const prefix = diffLinePrefix(line, preview.digits);
          const gutter = prefix.length + 1;
          return (
            <box
              key={line.id}
              width="100%"
              height={1}
              flexDirection="row"
              backgroundColor={
                line.kind === "add"
                  ? colors.addedBg
                  : line.kind === "remove"
                    ? colors.removedBg
                    : palette.surface
              }
            >
              {prefix && (
                <text
                  fg={tone}
                  height={1}
                  width={gutter}
                  bg={
                    line.kind === "add"
                      ? colors.addedLineNumberBg
                      : line.kind === "remove"
                        ? colors.removedLineNumberBg
                        : palette.surface
                  }
                  selectable={false}
                >{` ${prefix}`}</text>
              )}
              <text
                fg={change ? palette.text : palette.muted}
                height={1}
                flexGrow={1}
                selectable
              >
                {terminalLine(
                  prefix ? line.text : ` ${line.text}`,
                  Math.max(1, innerWidth - (prefix ? gutter : 0)),
                )}
              </text>
            </box>
          );
        })
      ) : (
        <text fg={palette.muted} paddingLeft={1}>
          {preview.error ?? emptyDiffMessage(diff)}
        </text>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+D toggles the latest card. */}
      <box
        id={`${id}-footer`}
        height={1}
        width="100%"
        paddingLeft={1}
        backgroundColor={palette.raised}
        onMouseUp={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          onToggle?.();
        }}
      >
        <text fg={palette.muted} height={1} selectable={false}>
          {terminalLine(footer, Math.max(1, innerWidth - 2))}
        </text>
      </box>
    </box>
  );
}
