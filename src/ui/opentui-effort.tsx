/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import {
  type ReasoningEffortCapability,
  resolveReasoningEffort,
} from "../providers/capabilities.js";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { terminalSafeText } from "./terminal-text.js";

export interface OpenTuiEffortActions {
  model: string;
  load(): Promise<{
    model: string;
    capability: ReasoningEffortCapability;
    current?: string;
  }>;
  select(level: string): Promise<string>;
}

export function OpenTuiEffort({
  actions,
  width,
  height,
  palette,
  onClose,
}: {
  actions: OpenTuiEffortActions;
  width: number;
  height: number;
  palette: Palette;
  onClose: (applied?: boolean) => void;
}) {
  const [data, setData] =
    useState<Awaited<ReturnType<OpenTuiEffortActions["load"]>>>();
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const current =
    resolveReasoningEffort(data?.capability, data?.current) ?? "auto";
  const levels = ["auto", ...(data?.capability.levels ?? [])];
  const detail =
    error ??
    data?.capability.reason ??
    (data?.current && current === "auto"
      ? "Сохранённый уровень недоступен. Используется Auto."
      : !data
        ? "Получаем уровни…"
        : undefined);
  const maxHeight = 6 + levels.length + (detail ? 2 : 0);
  const layout = dialogLayout(width, height, maxHeight, 52);
  const visible = Math.max(
    1,
    layout.popupHeight -
      (layout.tiny ? 0 : 2) -
      (layout.roomy ? 2 : 0) -
      3 -
      (detail ? 2 : 0),
  );
  const start = Math.max(0, index - visible + 1);

  useEffect(() => {
    let active = true;
    void actions
      .load()
      .then((next) => {
        if (!active) return;
        setData(next);
        const current = resolveReasoningEffort(next.capability, next.current);
        setIndex(
          current ? (next.capability.levels?.indexOf(current) ?? -1) + 1 : 0,
        );
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [actions]);

  const apply = (level: string) => {
    if (saving.current) return;
    saving.current = true;
    void actions
      .select(level)
      .then(() => onClose(true))
      .catch((error) => {
        setError(String(error));
      })
      .finally(() => {
        saving.current = false;
      });
  };

  useUiKeyboard((key) => {
    if (
      capturedInputOwner(key) !== "dialog" ||
      key.ctrl ||
      key.meta ||
      key.option
    )
      return;
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "escape" && !saving.current) onClose();
    if (key.name === "up") setIndex((value) => Math.max(0, value - 1));
    if (key.name === "down")
      setIndex((value) => Math.min(levels.length - 1, value + 1));
    if (key.name === "return" && !key.repeated) apply(levels[index] ?? "auto");
  });

  return (
    <OpenTuiDialog
      id="effort"
      width={width}
      height={height}
      maxWidth={52}
      maxHeight={maxHeight}
      palette={palette}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <text height={1} fg={palette.text} attributes={TextAttributes.BOLD}>
        Глубина рассуждений
      </text>
      <text height={1} fg={palette.muted} wrapMode="none" truncate>
        {terminalSafeText(data?.model ?? actions.model, 200)}
      </text>
      {levels.slice(start, start + visible).map((level, offset) => (
        <DialogAction
          key={level}
          palette={palette}
          active={start + offset === index}
          label={`${start + offset === index ? "›" : " "} ${level === "auto" ? "Auto" : level}`}
          trailing={
            level === current
              ? { label: "+ текущий" }
              : level === data?.capability.defaultLevel
                ? { label: "по умолчанию" }
                : undefined
          }
          onSelect={() => apply(level)}
        />
      ))}
      {detail && (
        <text height={2} fg={error ? palette.red : palette.muted}>
          {terminalSafeText(detail, 250)}
        </text>
      )}
      <text height={1} fg={palette.muted} wrapMode="none" truncate>
        ↑↓ Выбор · Enter Применить · Esc Назад
      </text>
    </OpenTuiDialog>
  );
}
