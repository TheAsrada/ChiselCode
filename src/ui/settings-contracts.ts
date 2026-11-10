import type { BackgroundSettingsActions } from "../background/settings.js";
import type { ExtensionManagementService } from "../extensions/management.js";
import type { LspSettingsActions } from "../lsp/settings.js";
import type {
  ConnectionChallenge,
  ConnectionStatus,
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import type { SubagentSettingsActions } from "../subagents/settings.js";
import type { ProviderId } from "../types/domain.js";
import type { WebSettingsActions } from "../web/settings.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { type SettingsRoute } from "./settings-catalog.js";
import {
  type ModelListResult,
  type TuiSettingsValues,
} from "./settings-values.js";

export interface OpenTuiSettingsActions {
  extensions?: ExtensionManagementService;
  background?: BackgroundSettingsActions;
  subagents?: SubagentSettingsActions;
  web?: WebSettingsActions;
  lsp?: LspSettingsActions;
  workspaceRoot?: string;
  catalog?(): Promise<{
    providers: ProviderDefinition[];
    profiles: Record<string, ProviderProfile>;
  }>;
  load(profileId?: string): Promise<{
    values: TuiSettingsValues;
    hasKey: boolean;
    accountLabel?: string;
  }>;
  hasKey(provider: ProviderId, profileId?: string): Promise<boolean>;
  save(
    values: TuiSettingsValues,
    previous?: TuiSettingsValues,
  ): Promise<"saved" | "setup_required">;
  activate?(values: TuiSettingsValues): Promise<void>;
  check(values: TuiSettingsValues): Promise<string>;
  models(values: TuiSettingsValues): Promise<ModelListResult>;
  connect?(
    values: TuiSettingsValues,
    signal: AbortSignal,
    challenge: (value: ConnectionChallenge) => void,
  ): Promise<ConnectionStatus>;
  disconnect?(values: TuiSettingsValues): Promise<void>;
  removeProfile?(profileId: string, expected?: ProviderProfile): Promise<void>;
}

export type Screen =
  | "menu"
  | "providers"
  | "profiles"
  | "model-list"
  | "model-manual"
  | "key"
  | "base-url"
  | "profile-id"
  | "profile-label"
  | "login"
  | "disconnect"
  | "delete-profile";
export type Page = SettingsRoute | "web";
export type Work =
  | "load"
  | "models"
  | "check"
  | "save"
  | "profile"
  | "theme"
  | "permissions"
  | "login"
  | "remove";
export const labels: Record<Screen, string> = {
  menu: "Подключение",
  providers: "Выберите сервис",
  profiles: "Выберите профиль",
  "model-list": "Выберите модель",
  "model-manual": "Название модели",
  key: "API-ключ",
  "base-url": "Адрес API",
  "profile-id": "Новый профиль",
  "profile-label": "Название профиля",
  login: "Вход в аккаунт",
  disconnect: "Отключить аккаунт",
  "delete-profile": "Удалить профиль",
};

export function safeNotice(
  message: unknown,
  values: TuiSettingsValues,
  editing: string,
  secret: boolean,
) {
  let text = message instanceof Error ? message.message : String(message);
  for (const key of [values.apiKey, secret ? editing : undefined]) {
    if (key) {
      text = text.split(key).join("[ключ скрыт]");
      if (key.trim()) text = text.split(key.trim()).join("[ключ скрыт]");
    }
  }
  return terminalSafeText(text, 600);
}
