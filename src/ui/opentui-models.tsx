/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { cleanSettingsInput } from "./opentui-settings-input.js";
import {
  filterModelOptions,
  type ModelListResult,
  type ModelOption,
  sortModelOptions,
} from "./settings-values.js";
import { useTerminalDecoration } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import { WARN_MARK } from "./theme.js";

export interface ModelSelection {
  provider: ProviderId;
  profileId?: string;
  model: string;
  baseUrl?: string;
}
export interface ModelProfile {
  key: string;
  label: string;
  providerLabel: string;
  selection: ModelSelection;
}
export interface OpenTuiModelsActions {
  load(): Promise<{ current: ModelSelection; profiles: ModelProfile[] }>;
  models(
    selection: ModelSelection,
    refresh?: boolean,
  ): Promise<ModelListResult>;
  select(selection: ModelSelection): Promise<void>;
}
function sameProfile(a?: ModelSelection, b?: ModelSelection) {
  return (
    !!a &&
    !!b &&
    a.provider === b.provider &&
    a.profileId === b.profileId &&
    a.baseUrl === b.baseUrl
  );
}

/** A picker is bound to the conversation that opened it, including async actions. */
export function OpenTuiModels({
  actions,
  width,
  height,
  palette = THEMES.obsidian,
  onClose,
  onSettings,
}: {
  actions: OpenTuiModelsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose(): void;
  onSettings(): void;
}) {
  const layout = dialogLayout(width, height, 26);
  const { borderChars } = useTerminalDecoration();
  const wide = layout.innerWidth >= 76 && layout.roomy;
  const [current, setCurrent] = useState<ModelSelection>();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [profile, setProfile] = useState<ModelProfile>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [page, setPage] = useState<"models" | "profiles" | "manual">("models");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [highlight, setHighlight] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const life = useRef({ mounted: false, operation: 0, saving: false });
  const fetchModels = useCallback(
    (next: ModelProfile, active?: ModelSelection, refresh = false) => {
      const operation = ++life.current.operation;
      const known = [
        sameProfile(next.selection, active) ? active?.model : undefined,
        next.selection.model,
      ].filter((id): id is string => !!id);
      if (!refresh) setModels([...new Set(known)].map((id) => ({ id })));
      setLoading(true);
      setError("");
      void actions
        .models(next.selection, refresh)
        .then((result) => {
          if (!life.current.mounted || operation !== life.current.operation)
            return;
          if (result.ok) {
            const merged = new Map<string, ModelOption>();
            for (const id of known) merged.set(id, { id });
            for (const model of result.models)
              if (model.id.trim()) merged.set(model.id, model);
            setModels(
              sortModelOptions(
                [...merged.values()],
                sameProfile(next.selection, active) ? active?.model : undefined,
              ),
            );
          } else setError(result.error);
        })
        .catch((failure) => {
          if (life.current.mounted && operation === life.current.operation)
            setError(String(failure));
        })
        .finally(() => {
          if (life.current.mounted && operation === life.current.operation)
            setLoading(false);
        });
    },
    [actions],
  );
  useEffect(() => {
    life.current.mounted = true;
    const operation = ++life.current.operation;
    void actions
      .load()
      .then((data) => {
        if (!life.current.mounted || operation !== life.current.operation)
          return;
        setCurrent(data.current);
        setProfiles(data.profiles);
        const selected =
          data.profiles.find((item) =>
            sameProfile(item.selection, data.current),
          ) ?? data.profiles[0];
        setProfile(selected);
        setHighlight(data.current.model);
        if (selected) fetchModels(selected, data.current);
        else setLoading(false);
      })
      .catch((failure) => {
        if (!life.current.mounted || operation !== life.current.operation)
          return;
        setError(String(failure));
        setLoading(false);
      });
    return () => {
      life.current.mounted = false;
      life.current.operation++;
    };
  }, [actions, fetchModels]);

  const choices = useMemo(
    () =>
      page === "profiles"
        ? profiles
            .filter((item) =>
              `${item.label} ${item.providerLabel} ${item.selection.profileId ?? ""}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .map((item) => ({
              id: item.key,
              title: item.label,
              hint: `${item.providerLabel} | ${item.selection.profileId ?? "текущая конфигурация"}`,
            }))
        : filterModelOptions(models, query).map((item) => ({
            ...item,
            title: item.hint && item.hint !== item.id ? item.hint : item.id,
          })),
    [page, profiles, models, query],
  );
  const index = Math.max(
    0,
    choices.findIndex((item) => item.id === highlight),
  );
  const chosen = choices[index];
  const rowHeight = layout.roomy ? 2 : 1;
  const capacity = Math.max(
    1,
    Math.floor((layout.popupHeight - (layout.roomy ? 18 : 8)) / rowHeight),
  );
  const start = Math.max(
    0,
    Math.min(index - Math.floor(capacity / 2), choices.length - capacity),
  );
  const listWidth = wide ? layout.innerWidth - 29 : layout.innerWidth;
  const clean = (value: string) =>
    cleanSettingsInput(value).replace(/[\r\n]/g, "");
  const changePage = (next: "models" | "profiles") => {
    if (life.current.saving) return;
    setPage(next);
    setQuery("");
    setError("");
    setHighlight(
      next === "profiles" ? (profile?.key ?? "") : (current?.model ?? ""),
    );
  };
  const enterManual = () => {
    if (!profile || life.current.saving) return;
    setManual(
      query.trim() ||
        (page === "models" ? chosen?.id : undefined) ||
        profile.selection.model,
    );
    setPage("manual");
    setError("");
  };
  const apply = (id: string) => {
    if (!profile || !id.trim() || life.current.saving) return;
    life.current.saving = true;
    setSaving(true);
    setError("");
    void actions
      .select({ ...profile.selection, model: id.trim() })
      .then(() => {
        if (life.current.mounted) onClose();
      })
      .catch((failure) => {
        if (life.current.mounted) setError(String(failure));
      })
      .finally(() => {
        life.current.saving = false;
        if (life.current.mounted) setSaving(false);
      });
  };
  const choose = (id = chosen?.id) => {
    if (!id || life.current.saving) return;
    if (page !== "profiles") return apply(id);
    const next = profiles.find((item) => item.key === id);
    if (!next) return;
    setProfile(next);
    setPage("models");
    setQuery("");
    setHighlight(next.selection.model);
    fetchModels(next, current);
  };
  const move = (delta: number) => {
    if (choices.length)
      setHighlight(
        choices[Math.max(0, Math.min(choices.length - 1, index + delta))]?.id ??
          "",
      );
  };
  const close = () => {
    if (!life.current.saving) onClose();
  };
  useKeyboard((key) => {
    const name = key.name.toLowerCase();
    if (key.ctrl && name === "c") return;
    if (name === "escape") {
      key.preventDefault();
      if (page === "manual") changePage("models");
      else close();
      return;
    }
    if (saving) {
      key.preventDefault();
      return;
    }
    if (name === "tab") {
      key.preventDefault();
      changePage(page === "profiles" ? "models" : "profiles");
      return;
    }
    if (key.ctrl && name === "n") {
      key.preventDefault();
      enterManual();
      return;
    }
    if (key.ctrl && name === "r") {
      key.preventDefault();
      if (profile) fetchModels(profile, current, true);
      return;
    }
    if (page === "manual") return;
    if (["up", "down", "pageup", "pagedown"].includes(name)) {
      key.preventDefault();
      move(
        (name === "up" || name === "pageup" ? -1 : 1) *
          (name.startsWith("page") ? capacity : 1),
      );
    }
  });
  const text = (value: string, limit = layout.innerWidth) =>
    terminalLine(value, Math.max(1, limit));
  const selectedModel =
    page === "models"
      ? models.find((item) => item.id === chosen?.id)
      : undefined;
  const detailProfile =
    page === "profiles"
      ? profiles.find((item) => item.key === chosen?.id)
      : profile;
  return (
    <OpenTuiDialog
      id="models"
      width={width}
      height={height}
      maxHeight={26}
      palette={palette}
      onClose={close}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
        height={1}
      >
        <text fg={palette.accent}>Выбор модели</text>
        <DialogAction
          id="models-close"
          label="x"
          palette={palette}
          onSelect={close}
        />
      </box>
      {layout.roomy && (
        <text fg={palette.muted} height={1}>
          Для следующего сообщения в этой сессии
        </text>
      )}
      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        marginTop={layout.roomy ? 1 : 0}
      >
        <DialogAction
          id="models-tab"
          label="Модели"
          active={page !== "profiles"}
          palette={palette}
          onSelect={() => changePage("models")}
        />
        <DialogAction
          id="models-profiles-tab"
          label={`Профили | ${profiles.length}`}
          active={page === "profiles"}
          palette={palette}
          onSelect={() => changePage("profiles")}
        />
      </box>
      {page !== "profiles" && (
        <text height={1} fg={palette.muted}>
          {text(
            profile
              ? `${profile.providerLabel} | ${profile.label}`
              : "Подключение не выбрано",
          )}
        </text>
      )}
      <box
        border={layout.roomy ? true : []}
        borderStyle="rounded"
        customBorderChars={borderChars}
        borderColor={palette.border}
        height={layout.roomy ? 3 : 1}
        flexShrink={0}
        marginTop={layout.roomy ? 1 : 0}
        paddingLeft={layout.roomy ? 1 : 0}
      >
        <input
          id={page === "manual" ? "models-manual" : "models-search"}
          key={page === "manual" ? "manual" : "search"}
          width="100%"
          focused={!saving}
          value={page === "manual" ? manual : query}
          placeholder={
            page === "manual"
              ? "Введите точный ID модели..."
              : page === "profiles"
                ? "Найти профиль или провайдера..."
                : "Найти модель по имени или ID..."
          }
          textColor={palette.text}
          backgroundColor={palette.surface}
          focusedBackgroundColor={palette.surface}
          cursorColor={palette.accent}
          onInput={(value) => {
            if (page === "manual") setManual(clean(value));
            else {
              setQuery(clean(value));
              setHighlight("");
            }
          }}
          onSubmit={(value) => {
            if (typeof value !== "string") return;
            const submitted = clean(value);
            if (page === "manual") return apply(submitted);
            if (submitted === query) return choose();
            const match =
              page === "profiles"
                ? profiles.find((item) =>
                    `${item.label} ${item.providerLabel} ${item.selection.profileId ?? ""}`
                      .toLowerCase()
                      .includes(submitted.trim().toLowerCase()),
                  )?.key
                : filterModelOptions(models, submitted)[0]?.id;
            if (match) choose(match);
          }}
        />
      </box>
      <box
        flexGrow={1}
        flexDirection="row"
        overflow="hidden"
        marginTop={layout.roomy ? 1 : 0}
      >
        <box
          width={listWidth}
          flexDirection="column"
          onMouseScroll={(event) => {
            move(event.scroll?.direction === "up" ? -1 : 1);
            event.stopPropagation();
          }}
        >
          {page === "manual" ? (
            <>
              <text height={1} fg={palette.accent}>
                ID модели вручную
              </text>
              {layout.roomy && (
                <text fg={palette.muted}>
                  {text(
                    "Используйте точный ID из документации провайдера. Каталог не обязателен.",
                    listWidth,
                  )}
                </text>
              )}
            </>
          ) : choices.length ? (
            choices.slice(start, start + capacity).map((item, offset) => {
              const active =
                page === "profiles"
                  ? item.id === profile?.key
                  : sameProfile(profile?.selection, current) &&
                    item.id === current?.model;
              const selected = start + offset === index;
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: Enter chooses the highlighted row.
                <box
                  id={`models-row-${start + offset}`}
                  key={item.id}
                  width={listWidth}
                  height={rowHeight}
                  flexShrink={0}
                  flexDirection="column"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={selected ? palette.raised : palette.surface}
                  onMouseUp={(event) => {
                    event.stopPropagation();
                    choose(item.id);
                  }}
                >
                  <text
                    height={1}
                    selectable={false}
                    fg={selected ? palette.accent : palette.text}
                  >
                    {text(
                      `${selected ? ">" : " "} ${active ? "+" : " "} ${item.title}`,
                      listWidth - 2,
                    )}
                  </text>
                  {rowHeight === 2 && (
                    <text height={1} selectable={false} fg={palette.muted}>
                      {text(
                        `    ${page === "profiles" ? item.hint : item.id}${active ? " | текущая" : ""}`,
                        listWidth - 2,
                      )}
                    </text>
                  )}
                </box>
              );
            })
          ) : (
            <text fg={palette.muted} height={1}>
              {loading
                ? "Получаю каталог..."
                : !profiles.length
                  ? "Добавьте профиль в настройках"
                  : "Ничего не найдено"}
            </text>
          )}
        </box>
        {wide && (
          <box
            width={28}
            paddingLeft={2}
            border={["left"]}
            customBorderChars={borderChars}
            borderColor={palette.border}
            flexDirection="column"
          >
            <text fg={palette.accent} height={1}>
              {page === "profiles" ? "Подключение" : "Модель"}
            </text>
            <text fg={palette.text}>
              {text(page === "manual" ? manual : (chosen?.id ?? "-"), 24)}
            </text>
            <text fg={palette.muted} marginTop={1}>
              {text(detailProfile?.providerLabel ?? "-", 24)}
            </text>
            {selectedModel?.contextWindow && (
              <text fg={palette.muted}>
                {text(
                  `Контекст: ${selectedModel.contextWindow.toLocaleString("en-US")}`,
                  24,
                )}
              </text>
            )}
            {selectedModel?.maxOutputTokens && (
              <text fg={palette.muted}>
                {text(
                  `Ответ: ${selectedModel.maxOutputTokens.toLocaleString("en-US")}`,
                  24,
                )}
              </text>
            )}
            <text fg={palette.muted} marginTop={1}>
              Разговор и черновик сохраняются.
            </text>
          </box>
        )}
      </box>
      <text
        height={1}
        flexShrink={0}
        fg={error ? palette.yellow : palette.muted}
      >
        {text(
          error
            ? `${WARN_MARK} ${error}`
            : saving
              ? "Сохраняю выбор..."
              : loading
                ? "Обновляю каталог... | можно выбрать ID вручную"
                : page === "manual"
                  ? "Enter выбрать | Esc назад"
                  : `${choices.length ? `${start + 1}-${Math.min(start + capacity, choices.length)} / ${choices.length}` : "0 результатов"} | ${layout.roomy ? "+ текущая" : "Up/Down Enter | Tab | Esc"}`,
        )}
      </text>
      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        marginTop={layout.roomy ? 1 : 0}
      >
        <DialogAction
          id="models-select"
          label="Выбрать"
          primary
          palette={palette}
          disabled={
            saving || !profile || (page === "manual" ? !manual.trim() : !chosen)
          }
          onSelect={() => (page === "manual" ? apply(manual) : choose())}
        />
        <DialogAction
          id="models-manual-action"
          label={layout.innerWidth < 45 ? "ID" : "Ввести ID"}
          palette={palette}
          disabled={saving || !profile}
          onSelect={enterManual}
        />
        <DialogAction
          id="models-settings"
          label={layout.innerWidth < 45 ? "API" : "Настройки"}
          palette={palette}
          disabled={saving}
          onSelect={onSettings}
        />
      </box>
      {layout.roomy && (
        <text height={1} flexShrink={0} fg={palette.muted}>
          {text(
            layout.innerWidth >= 90
              ? "Up/Down выбор | Enter принять | Tab профили | Ctrl+N ID | Ctrl+R обновить | Esc"
              : "Up/Down выбор | Enter | Tab профили | Ctrl+N ID | Ctrl+R обн. | Esc",
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
