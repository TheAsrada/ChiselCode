/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";
import type { UpdateController, UpdateState } from "./update-controller.js";

export function updateNotice(state?: UpdateState): string | undefined {
  const plan = state?.plan;
  if (!plan?.updateAvailable || plan.error || plan.assetReady !== true)
    return undefined;
  return state?.downloaded
    ? `Обновление v${plan.latest} готово | /update`
    : `Доступно обновление v${plan.latest} | /update`;
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace(".", ",");
}

export function OpenTuiUpdate({
  updater,
  width,
  height,
  palette,
  onClose,
}: {
  updater: UpdateController;
  width: number;
  height: number;
  palette: Palette;
  onClose: () => void;
}) {
  const [state, setState] = useState(updater.snapshot);
  const [selection, setSelection] = useState(0);
  useEffect(() => updater.subscribe(setState), [updater]);
  const layout = dialogLayout(width, height, 23, 80);
  const { plan, downloaded, phase } = state;
  const busy = updater.busy;
  const downloading = phase === "downloading" || phase === "verifying";
  const restarting = phase === "launching";
  const ready = !!downloaded;
  const canDownload =
    !!plan?.installedBinary &&
    plan.updateAvailable &&
    !plan.error &&
    plan.assetReady === true;
  const restartBlocked = ready && !!plan?.autoInstall && !updater.canRestart;
  const primaryLabel = busy
    ? restarting
      ? "Перезапускаю..."
      : downloading
        ? "Скачиваю..."
        : "Проверяю..."
    : ready
      ? plan?.autoInstall
        ? "Перезапустить"
        : "Готово"
      : canDownload
        ? phase === "error" || phase === "cancelled"
          ? "Повторить"
          : "Скачать"
        : "Проверить снова";
  const close = () => {
    if (restarting) return;
    updater.cancel();
    onClose();
  };
  const primary = () => {
    if (busy || restartBlocked) return;
    if (ready && plan?.autoInstall) void updater.restart();
    else if (ready) close();
    else if (canDownload) void updater.prepare();
    else void updater.check(true);
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return;
    key.preventDefault();
    if (key.name === "escape") return close();
    if (restarting) return;
    if (["tab", "left", "right"].includes(key.name))
      setSelection((value) => 1 - value);
    if (key.name === "return") {
      if (selection === 1) close();
      else primary();
    }
  });

  const fraction = state.totalBytes
    ? Math.min(1, Math.max(0, state.bytes / state.totalBytes))
    : 0;
  const percent = Math.floor(fraction * 100);
  const progressWidth = Math.max(1, layout.innerWidth - 2);
  const filled = Math.floor(progressWidth * fraction);
  const headline = restarting
    ? "Запускаю установщик"
    : ready
      ? plan?.autoInstall
        ? "Готово к установке"
        : "Установщик скачан и проверен"
      : phase === "verifying"
        ? "Проверяю размер и SHA-256"
        : phase === "downloading"
          ? "Скачиваю обновление"
          : phase === "checking"
            ? "Проверяю новые версии"
            : phase === "current"
              ? "Установлена актуальная версия"
              : phase === "error"
                ? "Обновление не завершено"
                : phase === "cancelled"
                  ? "Загрузка отменена"
                  : phase === "unavailable"
                    ? "Установщик ещё готовится"
                    : "Доступна новая версия";
  const headlineColor =
    phase === "error" ? palette.red : ready ? palette.green : palette.accent;
  const steps = [
    ["01", "Версия", !!plan, phase === "checking"],
    ["02", "Загрузка", ready || phase === "verifying", phase === "downloading"],
    ["03", "SHA-256", ready, phase === "verifying"],
  ] as const;

  return (
    <OpenTuiDialog
      id="update"
      width={width}
      height={height}
      maxWidth={80}
      maxHeight={23}
      palette={palette}
      onClose={close}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
        height={1}
      >
        <text fg={palette.text} height={1}>
          <strong>
            {layout.tiny ? "Обновление" : "Обновление ChiselCode"}
          </strong>
        </text>
        {!layout.tiny && (
          <DialogAction
            label="Esc x"
            palette={palette}
            disabled={restarting}
            onSelect={close}
          />
        )}
      </box>
      {layout.roomy && (
        <text fg={palette.muted} height={1} flexShrink={0}>
          Новая версия без потери сессий и настроек
        </text>
      )}
      <TerminalScrollbox
        id="update-content"
        flexGrow={1}
        minHeight={0}
        width="100%"
        scrollbarOptions={{ visible: false }}
        contentOptions={{
          flexDirection: "column",
          paddingTop: layout.roomy ? 1 : 0,
          gap: layout.roomy ? 1 : 0,
        }}
      >
        <box
          width="100%"
          flexShrink={0}
          flexDirection={layout.innerWidth >= 52 ? "row" : "column"}
          backgroundColor={palette.raised}
          paddingLeft={1}
          paddingRight={1}
          justifyContent="space-between"
        >
          <text fg={palette.muted} height={1}>
            Сейчас <span fg={palette.text}>v{state.current}</span>
          </text>
          <text fg={palette.muted} height={1}>
            {plan?.latest ? (
              <>
                {plan.updateAvailable ? "Новая " : "Последняя "}
                <span fg={palette.accent}>v{plan.latest}</span>
              </>
            ) : (
              "Проверка GitHub Releases"
            )}
          </text>
        </box>
        <text fg={headlineColor} flexShrink={0}>
          <strong>{headline}</strong>
        </text>
        {(downloading || ready || restarting) && (
          <box
            id="update-progress"
            width="100%"
            flexDirection="column"
            flexShrink={0}
            backgroundColor={palette.raised}
            paddingLeft={1}
            paddingRight={1}
          >
            <box
              width={progressWidth}
              height={1}
              flexDirection="row"
              backgroundColor={palette.border}
            >
              {filled > 0 && (
                <box
                  width={filled}
                  height={1}
                  backgroundColor={ready ? palette.green : palette.accent}
                />
              )}
            </box>
            <text fg={palette.text} height={1}>
              {terminalLine(
                `${megabytes(state.bytes)}${state.totalBytes ? ` / ${megabytes(state.totalBytes)}` : ""} МБ${state.totalBytes ? ` | ${percent}%` : ""}`,
                progressWidth,
              )}
            </text>
          </box>
        )}
        {layout.roomy && (
          <box flexDirection="row" gap={2} flexShrink={0}>
            {steps.map(([number, label, done, active]) => (
              <text
                key={number}
                fg={
                  done ? palette.green : active ? palette.accent : palette.muted
                }
                height={1}
              >
                {number} {label}
              </text>
            ))}
          </box>
        )}
        {phase === "current" && (
          <text fg={palette.muted}>Можно продолжать работу.</text>
        )}
        {phase === "checking" && (
          <text fg={palette.muted}>Проверяю последний стабильный релиз.</text>
        )}
        {canDownload && !ready && !downloading && (
          <text fg={palette.muted}>
            Установщик {megabytes(plan?.assetSize ?? 0)} МБ. После загрузки
            проверю размер и контрольную сумму.
          </text>
        )}
        {ready && plan?.autoInstall && (
          <text fg={palette.muted}>
            Перезапустите ChiselCode для установки v{plan.latest}. Установщик
            заменит файлы и откроет приложение в текущем проекте.
          </text>
        )}
        {ready && !plan?.autoInstall && (
          <box flexDirection="column" gap={1} flexShrink={0}>
            <text fg={palette.muted}>
              Установите пакет, затем перезапустите ChiselCode:
            </text>
            <box backgroundColor={palette.raised} width="100%">
              <text fg={palette.text}>
                {terminalSafeText(
                  plan?.manualCommand ?? downloaded?.path ?? "",
                )}
              </text>
            </box>
          </box>
        )}
        {plan?.updateAvailable && !plan.installedBinary && (
          <text fg={palette.muted}>
            Запущено из исходников или через Bun. Обновите исходники либо
            установите готовый пакет со страницы релиза.
          </text>
        )}
        {phase === "unavailable" && (
          <text fg={palette.muted}>
            Релиз опубликован, файлы ещё собираются. Проверьте чуть позже.
          </text>
        )}
        {(state.error || restartBlocked) && (
          <text fg={state.error ? palette.red : palette.yellow}>
            {terminalSafeText(
              state.error ??
                "Запрос ещё выполняется. Перезапуск доступен после завершения запроса и очереди.",
            )}
          </text>
        )}
        {(phase === "unavailable" ||
          phase === "error" ||
          (plan?.updateAvailable && !plan.installedBinary)) && (
          <text fg={palette.accent}>
            {terminalSafeText(
              plan?.latestUrl ??
                "https://github.com/TheAsrada/ChiselCode/releases",
            )}
          </text>
        )}
      </TerminalScrollbox>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <DialogAction
          id="update-primary"
          label={primaryLabel}
          palette={palette}
          primary={selection === 0}
          active={selection === 0}
          disabled={busy || restartBlocked}
          onSelect={primary}
        />
        <DialogAction
          id="update-later"
          label={busy ? "Отмена" : "Позже"}
          palette={palette}
          active={selection === 1}
          disabled={restarting}
          onSelect={close}
        />
      </box>
      {layout.roomy && (
        <text fg={palette.muted} height={1} flexShrink={0}>
          Tab выбор | Enter подтвердить | Esc закрыть
        </text>
      )}
    </OpenTuiDialog>
  );
}
