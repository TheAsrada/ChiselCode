import { useMemo } from "react";
import type {
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import {
  type OpenTuiSettingsActions,
  type Screen,
} from "./settings-contracts.js";
import { sortModelOptions, type TuiSettingsValues } from "./settings-values.js";

export function useConnectionSettingsModel({
  providers,
  values,
  hasKey,
  accountLabel,
  profiles,
  selected,
  query,
  models,
  screen,
  editing,
  loaded,
  baseline,
  actions,
}: {
  providers: ProviderDefinition[];
  values: TuiSettingsValues;
  hasKey: boolean;
  accountLabel: string | undefined;
  profiles: Record<string, ProviderProfile>;
  selected: number;
  query: string;
  models: { id: string; hint?: string }[];
  screen: Screen;
  editing: string;
  loaded: boolean;
  baseline: string;
  actions: OpenTuiSettingsActions | undefined;
}) {
  const definition = providers.find((p) => p.id === values.provider);

  const subscription = definition?.auth.type === "subscription";

  const endpoint =
    !subscription && definition?.endpoint.normalization !== "none";

  const rows: Array<{
    screen: Screen;
    label: string;
    value: string;
    help: string;
  }> = [
    {
      screen: "providers",
      label: "Сервис",
      value: definition?.label ?? values.provider,
      help: "Сервис этого профиля. Для другого сервиса добавьте подключение.",
    },
    {
      screen: "model-list",
      label: "Модель",
      value: values.model || "Не выбрана",
      help: "Выберите доступную модель или введите точный ID.",
    },
    {
      screen: subscription ? "login" : "key",
      label: subscription ? "Аккаунт" : "API-ключ",
      value: subscription
        ? hasKey
          ? (accountLabel ?? "Подключён")
          : "Войти по коду"
        : values.apiKey
          ? "Новый ключ"
          : hasKey
            ? "Сохранён"
            : definition?.auth.required === false
              ? "Не требуется"
              : "Не настроен",
      help: subscription
        ? "Войдите через браузер по одноразовому коду."
        : "Ключ скрыт при вводе. Новый ключ заменит текущий только после сохранения. Пустое поле оставляет сохранённый ключ.",
    },
    ...(endpoint
      ? [
          {
            screen: "base-url" as const,
            label: "Адрес API",
            value: values.baseUrl || "По умолчанию",
            help: "Адрес подключения к сервису. Используйте полный URL с http:// или https://.",
          },
        ]
      : []),
    {
      screen: "profiles",
      label: "Профиль",
      value: values.profileId || "Выберите профиль",
      help: "Все сохранённые аккаунты и подключения.",
    },
    {
      screen: "profile-id",
      label: "Добавить подключение",
      value: "Добавить аккаунт",
      help: "Выберите сервис и задайте имя нового профиля.",
    },
    {
      screen: "profile-label",
      label: "Название",
      value: values.label || values.profileId || "Без названия",
      help: "Отображаемое название аккаунта. ID профиля сохраняется.",
    },
    ...(subscription && hasKey && actions?.disconnect
      ? [
          {
            screen: "disconnect" as const,
            label: "Отключить аккаунт",
            value: "Удалить сохранённый вход",
            help: "Вход будет удалён только из этого профиля.",
          },
        ]
      : []),
    ...(values.profileId && profiles[values.profileId] && actions?.removeProfile
      ? [
          {
            screen: "delete-profile" as const,
            label: "Удалить профиль",
            value: values.label || values.profileId,
            help: "Профиль и его сохранённый вход будут удалены.",
          },
        ]
      : []),
  ];

  const menuIndex = Math.min(selected, rows.length - 1);

  const filteredProviders = providers.filter((p) =>
    `${p.id} ${p.label} ${p.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );

  const filteredProfiles = Object.entries(profiles).filter(([id, p]) =>
    `${id} ${p.label ?? ""} ${p.providerId} ${providers.find((provider) => provider.id === p.providerId)?.label ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );

  const filteredModels = useMemo(
    () =>
      sortModelOptions(models, values.model).filter((m) =>
        `${m.id} ${m.hint ?? ""}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    [models, query, values.model],
  );

  const choices =
    screen === "providers"
      ? filteredProviders.map((p) => ({
          id: p.id,
          label: p.label,
          hint: p.description ?? p.id,
        }))
      : screen === "profiles"
        ? [
            ...filteredProfiles.map(([id, p]) => ({
              id,
              label: `${id === values.profileId ? "● " : ""}${p.label ?? id}`,
              hint: `${providers.find((provider) => provider.id === p.providerId)?.label ?? p.providerId} · ${p.defaultModel ?? "модель не выбрана"}`,
            })),
            {
              id: "__new-profile",
              label: "Добавить подключение",
              hint: "API или подписка",
            },
          ]
        : screen === "model-list"
          ? [
              ...filteredModels.map((m) => ({ ...m, label: m.id })),
              {
                id: "__manual",
                label: "Ввести вручную...",
                hint: query || "Точное название модели",
              },
            ]
          : [];

  const choiceIndex = Math.min(selected, Math.max(0, choices.length - 1));

  const selector =
    screen === "providers" || screen === "profiles" || screen === "model-list";

  const field =
    screen === "model-manual" ||
    screen === "key" ||
    screen === "base-url" ||
    screen === "profile-id" ||
    screen === "profile-label";

  const fieldDirty =
    field &&
    editing !==
      (screen === "key"
        ? (values.apiKey ?? "")
        : screen === "base-url"
          ? (values.baseUrl ?? "")
          : screen === "profile-label"
            ? (values.label ?? "")
            : screen === "profile-id"
              ? ""
              : values.model);

  const dirty =
    !!actions && loaded && (baseline !== JSON.stringify(values) || fieldDirty);
  return {
    definition,
    subscription,
    rows,
    menuIndex,
    filteredProviders,
    choices,
    choiceIndex,
    selector,
    field,
    fieldDirty,
    dirty,
  };
}
