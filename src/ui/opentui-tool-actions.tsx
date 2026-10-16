/** @jsxImportSource @opentui/react */
import type { ChatCard } from "../types/chat-presentation.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";

import { terminalLine, terminalSafeText } from "./terminal-text.js";
import {
  ACTION_PAGE,
  type ActionGroup,
  type ActionPresentation,
  type ActionTarget,
  actionCategory,
  actionFailed,
  actionLabel,
  actionReason,
  actionRunning,
  actionStateLabels,
  OUTPUT_CHUNK,
} from "./tool-actions.js";

export function ToolActions({
  group,
  state,
  width,
  palette,
  focusedId,
  onSelect,
  onCardAction,
}: {
  group: ActionGroup;
  state: ActionPresentation;
  width: number;
  palette: Palette;
  focusedId?: string;
  onSelect(target: ActionTarget): void;
  onCardAction?(
    action: NonNullable<ChatCard["actions"]>[number],
    extensionId?: string,
  ): void;
}) {
  const open = state.expanded.has(group.id);
  const running = group.items.filter(actionRunning);
  const errors = group.items.filter(actionFailed);
  const lastError = errors.at(-1);
  const current = running.at(-1);
  const skill = group.kind === "skills";
  const categories = new Map<string, number>();
  for (const item of group.items)
    categories.set(
      actionCategory(item),
      (categories.get(actionCategory(item)) ?? 0) + 1,
    );
  const summary = [...categories]
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
  const status = errors.length
    ? `Ошибки ${errors.length}`
    : current
      ? actionStateLabels[current.state]
      : skill
        ? `Загружено ${group.items.length}`
        : `Готово ${group.items.length}`;
  const names = group.items
    .map((item) => String(item.input.name ?? item.name))
    .join(", ");
  const title = skill
    ? `Навыки ${group.items.length} · ${names}`
    : width < 32
      ? `Действия агента ${group.items.length}`
      : `Действия агента · ${group.items.length}${current && lastError ? ` · ${actionStateLabels[current.state]}: ${actionLabel(current)}` : width >= 60 ? ` · ${summary}` : ""}`;
  const detail = lastError
    ? `${status}: ${actionReason(lastError)}`
    : current
      ? `${skill ? "Загрузка" : status} · ${skill ? String(current.input.name ?? current.name) : actionLabel(current)}${current.progress ? ` · ${current.progress}` : ""}`
      : skill
        ? status
        : width >= 60
          ? status
          : `${summary} · ${status}`;
  const tone = errors.length ? "error" : current ? "accent" : "muted";
  const activeCard = current?.foreground;
  const controls = activeCard?.card.actions ?? [];
  const buttonWidth = controls.length ? (width < 50 ? 15 : 24) : 0;
  return (
    <box
      id={group.id}
      width="100%"
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      backgroundColor={palette.surface}
    >
      <box width="100%" flexDirection="row" height={1}>
        <DialogAction
          id={`${group.id}-toggle`}
          palette={palette}
          active={focusedId === group.id}
          tone={tone}
          label={terminalLine(
            `${open ? "▾" : "▸"} ${title}`,
            Math.max(1, width - 2 - buttonWidth),
          )}
          onSelect={() => onSelect({ id: group.id, group })}
        />
        {controls.map((action) => (
          <DialogAction
            key={action.action}
            id={`chat-card-${action.action}-${JSON.stringify([activeCard?.extensionId, activeCard?.card.id])}`}
            label={
              width < 50
                ? action.action === "promote"
                  ? "Фон"
                  : "Стоп"
                : action.label
            }
            palette={palette}
            onSelect={() => onCardAction?.(action, activeCard?.extensionId)}
          />
        ))}
      </box>
      <text
        height={1}
        fg={errors.length ? palette.red : palette.muted}
        paddingLeft={2}
        selectable={false}
      >
        {terminalLine(detail, Math.max(1, width - 2))}
      </text>
      {open &&
        group.items
          .slice(0, state.limits.get(group.id) ?? ACTION_PAGE)
          .map((item) => {
            const meta = item.result?.details?.skill;
            const skillInfo =
              meta && typeof meta === "object"
                ? (meta as { description?: string; source?: string })
                : undefined;
            const source =
              (
                {
                  bundled: "Встроенный",
                  user: "Библиотека пользователя",
                  project: "Проект",
                } as Record<string, string>
              )[skillInfo?.source ?? ""] ??
              skillInfo?.source ??
              "Источник не сохранён";
            const outputOpen = state.outputs.has(item.id);
            const output = state.pages.get(item.id);
            const content = output?.text ?? item.result?.output ?? "";
            const chunk = output?.chunk ?? 0;
            return (
              <box
                key={item.id}
                id={`action-item:${item.id}`}
                width="100%"
                flexDirection="column"
                paddingLeft={2}
                paddingRight={1}
                marginTop={1}
              >
                <text
                  fg={
                    actionFailed(item)
                      ? palette.red
                      : actionRunning(item)
                        ? palette.accent
                        : palette.text
                  }
                >
                  {terminalSafeText(
                    `${actionStateLabels[item.state]} · ${skill ? String(item.input.name ?? item.name) : actionLabel(item)}`,
                    4000,
                  )}
                </text>
                {skill ? (
                  <>
                    <text fg={palette.muted}>
                      {terminalSafeText(
                        `${source}${skillInfo?.description ? ` · ${skillInfo.description}` : ""}`,
                        1500,
                      )}
                    </text>
                    {actionFailed(item) && (
                      <text fg={palette.red}>
                        {terminalSafeText(actionReason(item), 1500)}
                      </text>
                    )}
                  </>
                ) : (
                  item.result && (
                    <>
                      <DialogAction
                        id={`action-output:${item.id}`}
                        label={`${outputOpen ? "v" : ">"} ${item.result.artifact ? "Полный сохранённый результат" : "Вывод"}`}
                        palette={palette}
                        active={focusedId === `action-output:${item.id}`}
                        onSelect={() =>
                          onSelect({
                            id: `action-output:${item.id}`,
                            action: item,
                          })
                        }
                      />
                      {outputOpen && (
                        <>
                          <text
                            id={`action-content:${item.id}`}
                            selectable
                            fg={output?.error ? palette.red : palette.muted}
                          >
                            {terminalSafeText(
                              output?.loading
                                ? "Чтение результата…"
                                : (output?.error ??
                                    content.slice(
                                      chunk * OUTPUT_CHUNK,
                                      (chunk + 1) * OUTPUT_CHUNK,
                                    )) ||
                                    "Пустой вывод",
                              OUTPUT_CHUNK,
                            )}
                          </text>
                          <box flexDirection="row" flexWrap="wrap">
                            <DialogAction
                              id={`action-prev:${item.id}`}
                              label="Назад"
                              palette={palette}
                              active={focusedId === `action-prev:${item.id}`}
                              onSelect={() =>
                                onSelect({
                                  id: `action-prev:${item.id}`,
                                  action: item,
                                  page: -1,
                                })
                              }
                            />
                            <DialogAction
                              id={`action-next:${item.id}`}
                              label="Далее"
                              palette={palette}
                              active={focusedId === `action-next:${item.id}`}
                              onSelect={() =>
                                onSelect({
                                  id: `action-next:${item.id}`,
                                  action: item,
                                  page: 1,
                                })
                              }
                            />
                            <text
                              fg={palette.muted}
                            >{`Строка ${(output?.offset ?? 0) + 1} · часть ${chunk + 1}`}</text>
                          </box>
                        </>
                      )}
                    </>
                  )
                )}
              </box>
            );
          })}
      {open &&
        group.items.length > (state.limits.get(group.id) ?? ACTION_PAGE) && (
          <DialogAction
            id={`action-more:${group.id}`}
            label={`Ещё ${Math.min(ACTION_PAGE, group.items.length - (state.limits.get(group.id) ?? ACTION_PAGE))} действий`}
            palette={palette}
            active={focusedId === `action-more:${group.id}`}
            onSelect={() =>
              onSelect({ id: `action-more:${group.id}`, group, more: true })
            }
          />
        )}
    </box>
  );
}
