/** @jsxImportSource @opentui/react */
import { useEffect, useState } from "react";
import type {
  ProjectMetadata,
  SessionSummary,
} from "../sessions/project-store.js";
import type { Palette } from "./appearance.js";
import { COMPACT_LOGO } from "./logo.js";
import type { OpenTuiSessionsActions } from "./opentui-sessions.js";
import { terminalSafeText } from "./opentui-transcript.js";
import type { TuiWorkspace } from "./tui-workspace.js";

function Action({
  label,
  active = false,
  onSelect,
  palette,
}: {
  label: string;
  active?: boolean;
  onSelect: () => void;
  palette: Palette;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Actions also have keyboard shortcuts or slash commands.
    <box
      backgroundColor={active ? palette.raised : palette.bg}
      onMouseUp={onSelect}
      flexShrink={0}
    >
      <text fg={active ? palette.accent : palette.muted}>{label}</text>
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
  const capacity = Math.max(1, Math.floor((width - 24) / 20));
  const activeIndex = workspace.tabs.findIndex(
    (tab) => tab.key === workspace.activeKey,
  );
  const start = Math.max(
    0,
    Math.min(activeIndex, workspace.tabs.length - capacity),
  );
  const visible = workspace.tabs.slice(start, start + capacity);
  const tabWidth = Math.max(
    5,
    Math.min(20, Math.floor((width - 24) / Math.max(1, visible.length))),
  );
  return (
    <box
      height={1}
      width={width}
      flexDirection="row"
      backgroundColor={palette.bg}
    >
      <Action
        label=" ⌂ Главная "
        active={!workspace.activeKey}
        onSelect={() => workspace.select()}
        palette={palette}
      />
      <Action
        label=" ‹ "
        onSelect={() => workspace.cycle(-1)}
        palette={palette}
      />
      {visible.map((tab) => (
        <Action
          key={tab.key}
          label={` ${terminalSafeText(`${tab.controller.snapshot.busy ? "● " : ""}${tab.controller.snapshot.sessionTitle ?? "Новая сессия"}`, tabWidth - 2).padEnd(tabWidth - 2)} `}
          active={workspace.activeKey === tab.key}
          onSelect={() => workspace.select(tab.key)}
          palette={palette}
        />
      ))}
      <box flexGrow={1} />
      <Action
        label=" › "
        onSelect={() => workspace.cycle(1)}
        palette={palette}
      />
      <Action
        label=" + "
        onSelect={() => workspace.newTab()}
        palette={palette}
      />
      <Action
        label=" × "
        onSelect={() => workspace.close()}
        palette={palette}
      />
    </box>
  );
}

export function OpenTuiHome({
  projectPath,
  width,
  height,
  palette,
  theme,
  sessions,
  loadProjects,
  onCommand,
}: {
  projectPath: string;
  width: number;
  height: number;
  palette: Palette;
  theme: string;
  sessions?: OpenTuiSessionsActions;
  loadProjects?: () => Promise<ProjectMetadata[]>;
  onCommand: (command: string) => void;
}) {
  const [recent, setRecent] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string>();
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  useEffect(() => {
    let current = true;
    setRecent([]);
    setError(undefined);
    void sessions
      ?.load()
      .then((items) => {
        if (current) setRecent(items.slice(0, 5));
      })
      .catch((err) => {
        if (current) setError(String(err));
      });
    return () => {
      current = false;
    };
  }, [sessions]);
  useEffect(() => {
    let current = true;
    void loadProjects?.()
      .then((items) => {
        if (current)
          setProjects(
            items
              .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
              .slice(0, 4),
          );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [loadProjects]);
  return (
    <box
      flexDirection="column"
      alignItems="center"
      width="100%"
      paddingTop={height >= 22 ? 2 : 0}
    >
      {height >= 22 &&
        width >= 46 &&
        COMPACT_LOGO.map((row) => (
          <text key={row} fg={palette.accent}>
            {row}
          </text>
        ))}
      <text fg={palette.accent}>ChiselCode</text>
      <text fg={palette.muted}>От задачи — к изменениям в коде</text>
      <box height={1} />
      <text fg={palette.text}>
        Проект · {terminalSafeText(projectPath, Math.max(8, width - 14))}
      </text>
      <box flexDirection="row" flexWrap="wrap" justifyContent="center">
        <Action
          label=" + Новая сессия "
          onSelect={() => onCommand("/new")}
          palette={palette}
        />
        <Action
          label=" История /sessions "
          onSelect={() => onCommand("/sessions")}
          palette={palette}
        />
        <Action
          label={` Тема ${theme} `}
          onSelect={() => onCommand("/theme")}
          palette={palette}
        />
      </box>
      <box flexDirection="row" flexWrap="wrap" justifyContent="center">
        <Action
          label=" Настройки /settings "
          onSelect={() => onCommand("/settings")}
          palette={palette}
        />
        <Action
          label=" Скиллы /skills "
          onSelect={() => onCommand("/skills")}
          palette={palette}
        />
        <Action
          label=" Справка /help "
          onSelect={() => onCommand("/help")}
          palette={palette}
        />
      </box>
      <box height={1} />
      <text fg={palette.muted}>Недавние сессии проекта</text>
      {error ? (
        <text fg={palette.muted}>{terminalSafeText(error, width - 4)}</text>
      ) : recent.length === 0 ? (
        <text fg={palette.muted}>Напишите задачу, чтобы начать разговор</text>
      ) : (
        recent.map((session) => (
          <Action
            key={session.id}
            label={` ${terminalSafeText(session.title ?? "Без названия", width - 4)} `}
            onSelect={() => onCommand(`/resume ${session.id}`)}
            palette={palette}
          />
        ))
      )}
      <box height={1} />
      <Action
        label=" Выбрать проект /cwd "
        onSelect={() => onCommand("/cwd")}
        palette={palette}
      />
      {projects
        .filter((project) => project.path !== projectPath)
        .map((project) => (
          <Action
            key={project.id}
            label={` ${terminalSafeText(project.name, width - 4)} `}
            onSelect={() => onCommand(`/cwd ${project.path}`)}
            palette={palette}
          />
        ))}
    </box>
  );
}
