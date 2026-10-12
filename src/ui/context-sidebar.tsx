/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useLayoutEffect, useRef } from "react";
import { contextProgress } from "../core/context-usage.js";
import { type Palette, THEMES } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { uiTone } from "./opentui-extension-details.js";
import { SidebarSection } from "./sidebar-panel.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

function leaf(path: string): string {
  return (
    path.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1) || path
  );
}

export function ContextSidebar({
  state,
  width = 40,
  height = 24,
  focused = false,
  palette = THEMES.obsidian,
  presentation,
  onAction,
}: {
  state: TuiViewState;
  width?: number;
  height?: number;
  focused?: boolean;
  palette?: Palette;
  presentation?: TuiController["sidebarPresentation"];
  onAction?(
    item: import("../extensions/ui-types.js").OwnedUiContribution,
  ): void;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const remembered = useRef(presentation?.scroll.get("context"));
  const restore = () => {
    if (
      remembered.current === undefined ||
      !scroll.current ||
      scroll.current.viewport.height === 0
    )
      return;
    scroll.current.scrollTo(remembered.current);
    remembered.current = undefined;
  };
  useLayoutEffect(() => {
    const body = scroll.current;
    if (!body || !presentation) return;
    body.scrollTo(presentation.scroll.get("context") ?? 0);
    return () => {
      presentation.scroll.set("context", body.scrollTop);
    };
  }, [presentation]);
  const usage = state.usage;
  const snapshot = state.contextSnapshot ?? usage?.contextSnapshot;
  const preferMetadata =
    snapshot?.windowSource !== "provider" &&
    state.modelCapabilities?.limitsSource === "provider";
  const window = preferMetadata
    ? (state.modelCapabilities?.contextWindow ?? snapshot?.contextWindow)
    : (snapshot?.contextWindow ?? state.modelCapabilities?.contextWindow);
  const windowSource = preferMetadata
    ? state.modelCapabilities?.limitsSource
    : (snapshot?.windowSource ?? state.modelCapabilities?.limitsSource);
  const progress = contextProgress(
    snapshot ? { ...snapshot, contextWindow: window } : undefined,
  );
  const inner = Math.max(1, width - 4);
  const cardWidth = Math.max(1, width - 2);
  const barWidth = Math.max(1, inner - 1);
  const filled =
    (progress.barPercent ?? 0) > 0
      ? Math.max(1, Math.round(((progress.barPercent ?? 0) / 100) * barWidth))
      : 0;
  const pressure =
    (progress.barPercent ?? 0) >= 90
      ? palette.red
      : (progress.barPercent ?? 0) >= 70
        ? palette.yellow
        : palette.accent;
  const selection = state.modelSelection;
  const files = state.gitChanges?.files ?? [];
  const totalTokens = usage
    ? usage.totalTokens.inputTokens + usage.totalTokens.outputTokens
    : 0;
  return (
    <TerminalScrollbox
      id="context-sidebar"
      ref={scroll}
      width={width}
      height={height}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={palette.surface}
      focused={focused}
      viewportCulling
      renderBefore={restore}
    >
      <SidebarSection
        title="МОДЕЛЬ"
        width={cardWidth}
        palette={palette}
        trailing={state.agentMode === "plan" ? "Plan" : "Build"}
      >
        <text
          height={1}
          fg={palette.text}
          attributes={TextAttributes.BOLD}
          content={terminalLine(
            selection?.model ?? usage?.model ?? "Модель не выбрана",
            inner,
          )}
        />
        <text
          height={1}
          fg={palette.muted}
          content={terminalLine(
            selection?.provider ?? usage?.provider ?? "Провайдер не выбран",
            inner,
          )}
        />
        {selection?.profileId && (
          <text
            height={1}
            fg={palette.muted}
            content={terminalLine(`Профиль: ${selection.profileId}`, inner)}
          />
        )}
      </SidebarSection>
      <SidebarSection
        title="ОКНО КОНТЕКСТА"
        width={cardWidth}
        palette={palette}
      >
        <text
          height={1}
          fg={pressure}
          attributes={TextAttributes.BOLD}
          content={terminalLine(
            snapshot ? progress.label : "Заполнение: —",
            inner,
          )}
        />
        {progress.barPercent !== undefined && (
          <text height={1} selectable={false}>
            <span bg={pressure}>{" ".repeat(filled)}</span>
            <span bg={palette.border}>{" ".repeat(barWidth - filled)}</span>
          </text>
        )}
        <text
          height={1}
          fg={palette.muted}
          content={terminalLine(
            window
              ? `Окно: ${window.toLocaleString("ru-RU")}${windowSource === "catalog" ? " (каталог)" : windowSource === "config" ? " (настройки)" : ""}`
              : "Размер окна неизвестен",
            inner,
          )}
        />
        {snapshot?.status === "estimated" && (
          <text height={1} fg={palette.muted}>
            ~ приблизительная оценка
          </text>
        )}
      </SidebarSection>
      {(usage || state.childSpend || state.sideSpend) && (
        <SidebarSection
          title="Расход сессии:"
          width={cardWidth}
          palette={palette}
          trailing={totalTokens.toLocaleString("ru-RU")}
        >
          {usage && (
            <text
              height={1}
              fg={palette.muted}
              content={terminalLine(
                `Вход ${usage.totalTokens.inputTokens.toLocaleString("ru-RU")} · выход ${usage.totalTokens.outputTokens.toLocaleString("ru-RU")}`,
                inner,
              )}
            />
          )}
          {state.childSpend && (
            <text
              height={1}
              fg={palette.muted}
              content={terminalLine(
                `Помощники: ${(state.childSpend.usage.inputTokens + state.childSpend.usage.outputTokens).toLocaleString("ru-RU")} ток.`,
                inner,
              )}
            />
          )}
          {state.sideSpend && (
            <text
              height={1}
              fg={palette.muted}
              content={terminalLine(
                `Побочные: ${(state.sideSpend.usage.inputTokens + state.sideSpend.usage.outputTokens).toLocaleString("ru-RU")} ток.`,
                inner,
              )}
            />
          )}
          {(state.childSpend?.unknownUsage ||
            state.sideSpend?.unknownUsage) && (
            <text height={1} fg={palette.yellow}>
              Часть расхода неизвестна
            </text>
          )}
          {usage?.totalCost !== undefined &&
            Number.isFinite(usage.totalCost) &&
            usage.totalCost > 0 && (
              <text height={1} fg={palette.text}>
                ${usage.totalCost.toFixed(4)}
              </text>
            )}
        </SidebarSection>
      )}
      <SidebarSection title="ПРОЕКТ" width={cardWidth} palette={palette}>
        <text
          height={1}
          fg={palette.text}
          attributes={TextAttributes.BOLD}
          content={terminalLine(leaf(state.projectPath), inner)}
        />
        <text
          height={1}
          fg={palette.muted}
          content={terminalLine(state.projectPath, inner)}
        />
        <text
          height={1}
          fg={state.gitChanges ? palette.accent : palette.muted}
          content={terminalLine(
            state.gitChanges
              ? state.gitChanges.branch === "HEAD"
                ? "Detached HEAD"
                : state.gitChanges.branch
              : "Без репозитория",
            inner,
          )}
        />
        {state.worktree && (
          <text
            height={1}
            fg={palette.muted}
            content={terminalLine(`Копия: ${state.worktree.label}`, inner)}
          />
        )}
      </SidebarSection>
      {state.gitChanges && (
        <SidebarSection
          title="ИЗМЕНЕНИЯ"
          width={cardWidth}
          palette={palette}
          trailing={`${state.gitChanges.totalFiles}`}
        >
          {files.length === 0 && (
            <text height={1} fg={palette.muted}>
              Рабочее дерево чистое
            </text>
          )}
          {files.slice(0, 8).map((file) => (
            <text key={file.path} height={1} fg={palette.text}>
              {terminalLine(
                leaf(file.path),
                Math.max(
                  1,
                  inner - ` +${file.additions} -${file.deletions}`.length,
                ),
              )}
              <span fg={palette.green}> +{file.additions}</span>
              <span fg={palette.red}> -{file.deletions}</span>
            </text>
          ))}
          {state.gitChanges.totalFiles > 8 && (
            <text height={1} fg={palette.muted}>
              …ещё {state.gitChanges.totalFiles - 8}
            </text>
          )}
        </SidebarSection>
      )}
      {(state.toolActivity || state.overlay) && (
        <SidebarSection title="АКТИВНОСТЬ" width={cardWidth} palette={palette}>
          <text
            fg={palette.yellow}
            content={terminalLine(
              state.overlay ?? state.toolActivity ?? "",
              inner,
            )}
          />
        </SidebarSection>
      )}
      {(state.uiContributions ?? [])
        .filter((item) => item.descriptor.slot === "context_section")
        .map((item) => (
          <SidebarSection
            key={item.key}
            title={item.descriptor.title}
            width={cardWidth}
            palette={palette}
            trailing={
              item.snapshot.count === undefined
                ? undefined
                : String(item.snapshot.count)
            }
          >
            <text
              fg={uiTone(palette, item.snapshot.tone)}
              content={terminalLine(
                item.snapshot.label ?? item.descriptor.title,
                inner,
              )}
            />
            {item.snapshot.detail && (
              <text fg={palette.muted} content={item.snapshot.detail} />
            )}
            {(item.snapshot.rows ?? []).slice(0, 8).map((row) => (
              <text
                key={row.id}
                fg={uiTone(palette, row.tone)}
                content={terminalLine(
                  `${row.label}${row.value ? ` · ${row.value}` : ""}`,
                  inner,
                )}
              />
            ))}
            <DialogAction
              label={
                item.snapshot.state === "unavailable"
                  ? "Повторить получение"
                  : "Открыть подробности"
              }
              palette={palette}
              onSelect={() => onAction?.(item)}
            />
          </SidebarSection>
        ))}
    </TerminalScrollbox>
  );
}
