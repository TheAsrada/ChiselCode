/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable } from "@opentui/core";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { WebConfig } from "../web/schema.js";
import { effectiveSearchBackend } from "../web/search.js";
import type { WebSettingsActions, WebSettingsState } from "../web/settings.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { SettingsSecretInput } from "./opentui-settings-input.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { useUiKeyboard } from "./overlay-input.js";
import { useSettingsAutosave } from "./settings-autosave.js";
import type { SettingsPanelControl } from "./settings-panel.js";
import { TerminalScrollbox } from "./terminal-decoration.js";

export function OpenTuiWebSettings({
  actions,
  palette,
  onClose,
  height = 20,
  active = true,
  controls,
  onDirty,
}: {
  actions: WebSettingsActions;
  palette: Palette;
  onClose(): void;
  height?: number;
  active?: boolean;
  controls?: MutableRefObject<SettingsPanelControl | undefined>;
  onDirty?(dirty: boolean): void;
}) {
  const [state, setState] = useState<WebSettingsState>();
  const [saved, setSaved] = useState<WebSettingsState>();
  const [pendingKey, setPendingKey] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [keyInput, setKeyInput] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const dirty =
    !!state &&
    (JSON.stringify(state.config) !== JSON.stringify(saved?.config) ||
      pendingKey !== undefined ||
      (keyInput !== undefined && !!keyInput));
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const alive = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    alive.current = true;
    void actions
      .load()
      .then((value) => {
        if (alive.current) {
          setState(value);
          setSaved(value);
        }
      })
      .catch(() => {
        if (alive.current)
          setNotice(
            "Не удалось прочитать Web settings. Проверьте конфигурацию.",
          );
      });
    return () => {
      alive.current = false;
    };
  }, [actions]);
  useEffect(() => {
    const box = scroll.current;
    if (!box || !active) return;
    if (keyInput !== undefined) {
      box.scrollTo(0);
      return;
    }
    const row = box.findDescendantById(`settings-web-row-${selected}`);
    if (row && row.y < box.viewport.y) box.scrollBy(row.y - box.viewport.y);
    else if (row && row.y + row.height > box.viewport.y + box.viewport.height)
      box.scrollBy(row.y + row.height - box.viewport.y - box.viewport.height);
  }, [selected, keyInput, active]);
  const autosave = useSettingsAutosave(
    dirty
      ? JSON.stringify({ config: state?.config, key: keyInput ?? pendingKey })
      : undefined,
    async () => {
      if (!state) return;
      const next = await actions.save(state.config, keyInput ?? pendingKey);
      setSaved(next);
      setState((current) =>
        current?.config === state.config ? next : current,
      );
      setPendingKey((current) =>
        current === pendingKey ? undefined : current,
      );
      setNotice("Сохранено");
    },
    (error) =>
      setNotice(error instanceof Error ? error.message : String(error)),
    keyInput !== undefined ? 350 : 0,
    state
      ? JSON.stringify({ config: state.config, key: keyInput ?? pendingKey })
      : undefined,
  );
  const activate = (index: number) => {
    if (!state) return;
    const config = structuredClone(state.config);
    if (index === 0) config.enabled = !config.enabled;
    else if (index === 3) {
      const providers = ["auto", "exa", "parallel", "brave"] as const;
      config.search.provider =
        providers[
          (providers.indexOf(config.search.provider) + 1) % providers.length
        ] ?? "auto";
    } else if (index === 4) {
      setKeyInput("");
      return;
    } else {
      const operation = index === 1 ? "search" : "fetch";
      const choices = ["ask", "allow", "deny"] as const;
      config.permissions[operation] =
        choices[(choices.indexOf(config.permissions[operation]) + 1) % 3] ??
        "ask";
    }
    setState({ ...state, config });
    setNotice("");
  };
  const acceptKey = () => {
    void autosave.flush().then((ok) => {
      if (ok) {
        setPendingKey(undefined);
        setKeyInput(undefined);
      }
    });
  };
  const saveCurrent = () => {
    void autosave.flush();
  };
  if (controls)
    controls.current = {
      save: saveCurrent,
      flush: autosave.flush,
      discard: () => {
        setState(saved);
        setKeyInput(undefined);
        setPendingKey(undefined);
        setNotice("");
      },
      back: () => {
        if (keyInput !== undefined) {
          void autosave.flush().then((ok) => {
            if (ok) setKeyInput(undefined);
          });
          return true;
        }
        return false;
      },
    };
  useUiKeyboard((key) => {
    if (!active) return;
    if ((key.ctrl && key.name === "c") || key.name === "tab") return;
    if (key.name === "escape") {
      key.preventDefault();
      if (keyInput !== undefined) acceptKey();
      else
        void autosave.flush().then((ok) => {
          if (ok) onClose();
        });
      return;
    }

    if (!controls && key.ctrl && key.name === "s") {
      key.preventDefault();
      saveCurrent();
      return;
    }
    if (keyInput !== undefined) {
      if (key.name === "return" && state) {
        key.preventDefault();
        acceptKey();
      }
      return;
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const rows = state?.config.search.provider === "brave" ? 5 : 4;
      setSelected((i) => (i + (key.name === "up" ? -1 : 1) + rows) % rows);
    }
    if (key.name === "return" || key.name === "space") {
      key.preventDefault();
      activate(selected);
    }
  });
  const compact = height < 12;
  const label = (rule: string) =>
    rule === "ask"
      ? "Спрашивать"
      : rule === "allow"
        ? "Разрешено"
        : "Запрещено";
  return (
    <TerminalScrollbox
      ref={scroll}
      id="settings-web-body"
      width="100%"
      height="100%"
    >
      <box flexDirection="column" gap={compact ? 0 : 1}>
        <text fg={palette.accent}>
          <strong>{`Публичный Web${dirty ? " · draft *" : ""}`}</strong>
        </text>
        {!compact && (
          <text fg={palette.muted}>
            Документация и актуальные источники для агента
          </text>
        )}
        {!state ? (
          <text fg={palette.muted}>Загрузка настроек…</text>
        ) : keyInput !== undefined ? (
          <box flexDirection="column" gap={1}>
            <text fg={palette.text}>API-ключ Brave Search</text>
            <SettingsSecretInput
              value={keyInput}
              onChange={setKeyInput}
              onSubmit={acceptKey}
              palette={palette}
              active={active}
            />
            <text fg={palette.muted}>
              Ключ хранится в CredentialStore. В конфиге — только ссылка.
            </text>
            <box flexDirection="row" gap={1}>
              <DialogAction
                id="settings-web-key-save"
                label="Готово"
                primary
                palette={palette}
                disabled={busy}
                onSelect={acceptKey}
              />
              <DialogAction
                id="settings-web-key-cancel"
                label="Назад"
                palette={palette}
                disabled={busy}
                onSelect={acceptKey}
              />
            </box>
          </box>
        ) : (
          <>
            {[
              ["Web доступ", state.config.enabled ? "Включён" : "Выключен"],
              ["Поиск", label(state.config.permissions.search)],
              ["Открытие страниц", label(state.config.permissions.fetch)],
              [
                "Сервис поиска",
                state.config.search.provider === "brave"
                  ? "Brave"
                  : state.config.search.provider === "exa"
                    ? "Exa · без ключа"
                    : state.config.search.provider === "parallel"
                      ? "Parallel · без ключа"
                      : "Авто",
              ],
              ...(state.config.search.provider === "brave"
                ? [
                    [
                      "Brave API-ключ",
                      state.hasKey ? "******** · настроен" : "Не настроен",
                    ],
                  ]
                : []),
            ].map(([name, value], index) => (
              <box
                key={name}
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={
                  selected === index ? palette.surface : undefined
                }
              >
                <DialogAction
                  id={`settings-web-row-${index}`}
                  label={name ?? ""}
                  palette={palette}
                  active={selected === index}
                  disabled={busy}
                  onSelect={() => {
                    setSelected(index);
                    activate(index);
                  }}
                />
                <text
                  fg={
                    index === 0 && state.config.enabled
                      ? palette.accent
                      : palette.muted
                  }
                >
                  {value}
                </text>
              </box>
            ))}
            <box
              border={["left"]}
              borderColor={palette.border}
              paddingLeft={1}
              flexDirection="column"
            >
              <text fg={palette.accent}>Безопасное чтение · включено</text>
              <text fg={palette.muted}>
                Локальные адреса и cloud metadata заблокированы
              </text>
              <text fg={palette.muted}>
                HTML без JavaScript, cookies и авторизации
              </text>
            </box>
            <text fg={palette.muted}>
              {state.config.search.provider === "auto"
                ? `Авто: ${state.hasKey ? "Brave, " : ""}Exa, Parallel. При недоступности используется следующий разрешённый сервис.`
                : effectiveSearchBackend(state.config, state.hasKey) === "brave"
                  ? state.hasKey
                    ? "Brave Search готов. Запросы уходят в Brave; страницы — их владельцам."
                    : "Brave требует ключ. Выберите Авто, Exa или Parallel для поиска без ключа."
                  : effectiveSearchBackend(state.config, state.hasKey) ===
                      "parallel"
                    ? "Parallel готов без API-ключа. Запросы уходят в Parallel; действуют лимиты сервиса."
                    : "Exa готов без API-ключа. Запросы уходят в Exa; действуют лимиты сервиса."}
            </text>
            {!compact && (
              <text fg={palette.muted}>
                {state.network?.error
                  ? "Ошибка сетевых переменных: chisel web status"
                  : `Сеть: ${state.network?.proxy ? "корпоративный proxy" : "прямое подключение"}${state.network?.extraCa ? " · свой CA" : ""}${state.network?.mtls ? " · mTLS" : ""} · TLS проверяется`}
              </text>
            )}
            <text fg={palette.muted}>
              Спрашивать включает подтверждения. Запреты доменов действуют
              всегда.
            </text>
          </>
        )}
        {notice && (
          <text fg={palette.muted}>{terminalSafeText(notice, 300)}</text>
        )}
      </box>
    </TerminalScrollbox>
  );
}
