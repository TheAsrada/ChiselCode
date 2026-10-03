/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { VERSION } from "../version.js";
import type { Palette } from "./appearance.js";
import {
  ASCII_LOGO,
  ASCII_LOGO_WIDTH,
  LOGO_WIDTH,
  renderLogoRows,
} from "./logo.js";
import { useTerminalDecoration } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiWorkspace } from "./tui-workspace.js";

function TabAction({
  id,
  label,
  width,
  palette,
  onSelect,
}: {
  id?: string;
  label: string;
  width: number;
  palette: Palette;
  onSelect: () => void;
}) {
  const { borderChars } = useTerminalDecoration();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Tab controls have keyboard equivalents.
    <box
      id={id}
      width={width}
      height={3}
      flexShrink={0}
      border
      borderStyle="rounded"
      customBorderChars={borderChars}
      borderColor={palette.border}
      backgroundColor={palette.surface}
      alignItems="center"
      onMouseUp={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <text fg={palette.muted} selectable={false}>
        {label}
      </text>
    </box>
  );
}

export function SessionTabs({
  workspace,
  width,
  palette,
}: {
  workspace: TuiWorkspace;
  width: number;
  palette: Palette;
}) {
  const { borderChars } = useTerminalDecoration();
  if (!workspace.tabs.length) return null;
  const overflow = workspace.tabs.length * 20 + 5 > width;
  const controls = overflow ? 11 : 5;
  const capacity = Math.max(1, Math.floor((width - controls) / 20));
  const activeIndex = workspace.tabs.findIndex(
    (tab) => tab.key === workspace.activeKey,
  );
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, activeIndex - capacity + 1),
      workspace.tabs.length - capacity,
    ),
  );
  const visible = workspace.tabs.slice(start, start + capacity);
  const tabWidth = Math.max(
    6,
    Math.min(26, Math.floor((width - controls) / Math.max(1, visible.length))),
  );
  return (
    <box
      id="session-tabs"
      height={3}
      width={width}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={palette.bg}
      overflow="hidden"
    >
      {overflow && (
        <TabAction
          label="<"
          width={3}
          palette={palette}
          onSelect={() => workspace.cycle(-1)}
        />
      )}
      {visible.map((tab) => {
        const active = workspace.activeKey === tab.key;
        const busy = !!tab.controller.snapshot.busy;
        const awaitingApproval = !!tab.controller.snapshot.awaitingApproval;
        const title = tab.controller.snapshot.sessionTitle ?? "Новая сессия";
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: Alt+Left/Right also selects tabs.
          <box
            key={tab.key}
            id={`session-${tab.key}`}
            width={tabWidth}
            height={3}
            flexShrink={0}
            border
            borderStyle="rounded"
            customBorderChars={borderChars}
            borderColor={
              awaitingApproval
                ? palette.yellow
                : active
                  ? palette.accent
                  : palette.border
            }
            backgroundColor={active ? palette.surface : palette.bg}
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => workspace.select(tab.key)}
          >
            <text
              fg={
                awaitingApproval
                  ? palette.yellow
                  : active
                    ? palette.text
                    : palette.muted
              }
              width={Math.max(1, tabWidth - 6)}
              height={1}
              selectable={false}
            >
              {terminalLine(
                `${awaitingApproval ? "? " : busy ? "* " : ""}${title}`,
                Math.max(1, tabWidth - 6),
              )}
            </text>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+W also closes the selected tab. */}
            <box
              width={1}
              height={1}
              onMouseUp={(event) => {
                event.stopPropagation();
                if (!busy) workspace.close(tab.key);
              }}
            >
              <text
                fg={busy ? palette.border : palette.muted}
                selectable={false}
              >
                x
              </text>
            </box>
          </box>
        );
      })}
      <TabAction
        id="new-session"
        label="+"
        width={5}
        palette={palette}
        onSelect={() => workspace.newDraft()}
      />
      {overflow && (
        <TabAction
          label=">"
          width={3}
          palette={palette}
          onSelect={() => workspace.cycle(1)}
        />
      )}
    </box>
  );
}

export function OpenTuiHome({
  projectPath,
  width,
  height,
  palette,
  children,
  feedback,
  updateNotice,
  onUpdate,
}: {
  projectPath: string;
  width: number;
  height: number;
  palette: Palette;
  children: ReactNode;
  feedback?: ReactNode;
  updateNotice?: string;
  onUpdate?: () => void;
}) {
  const { unicode } = useTerminalDecoration();
  const logoWidth = unicode ? LOGO_WIDTH : ASCII_LOGO_WIDTH;
  const logoRows = unicode ? renderLogoRows() : ASCII_LOGO;
  const fullLogo = width >= logoWidth + 4 && height >= 18;
  const contentWidth = Math.max(1, Math.min(86, width - (width >= 40 ? 4 : 0)));
  return (
    <box
      id="welcome"
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexGrow={1} minHeight={0} />
      <box
        width={contentWidth}
        flexShrink={0}
        flexDirection="column"
        alignItems="center"
      >
        {fullLogo ? (
          <box
            id="welcome-logo"
            width={logoWidth}
            height={5}
            flexShrink={0}
            flexDirection="column"
          >
            {logoRows.map((row) => (
              <text key={row} height={1} selectable={false}>
                <span fg={palette.accent}>{row.slice(0, 15)}</span>
                <span fg={palette.text}>{row.slice(15)}</span>
              </text>
            ))}
          </box>
        ) : (
          <text
            id="welcome-logo"
            fg={palette.text}
            height={1}
            selectable={false}
          >
            <span fg={palette.accent}>{"<i> "}</span>
            <strong>ChiselCode</strong>
          </text>
        )}
        <box height={height >= 12 ? 1 : 0} flexShrink={0} />
        {children}
        {updateNotice && (
          // biome-ignore lint/a11y/noStaticElementInteractions: /update also opens the updater.
          <box
            id="welcome-update"
            width="100%"
            height={1}
            flexShrink={0}
            flexDirection="row"
            backgroundColor={palette.raised}
            onMouseUp={onUpdate}
          >
            <box width={1} height={1} backgroundColor={palette.accent} />
            <text fg={palette.accent} height={1} paddingLeft={1}>
              {terminalLine(updateNotice, Math.max(1, contentWidth - 3))}
            </text>
          </box>
        )}
        {feedback}
      </box>
      <box flexGrow={1.3} minHeight={0} />
      {height >= 10 && (
        <box
          height={1}
          width="100%"
          flexShrink={0}
          flexDirection="row"
          justifyContent="space-between"
        >
          <text fg={palette.muted} height={1}>
            {terminalLine(projectPath, Math.max(1, width - 22))}
          </text>
          <text fg={palette.muted} height={1}>
            ChiselCode {VERSION}
          </text>
        </box>
      )}
    </box>
  );
}
