import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { ProfileIdSchema } from "../config/schema.js";
import {
  type CredentialsReader,
  resolveCredential,
} from "../providers/auth.js";
import type {
  ConnectionChallenge,
  ProviderProfile,
} from "../providers/contracts.js";
import { builtinDefinitions } from "../providers/definitions/index.js";
import { normalizeEndpoint } from "../providers/endpoint.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { CredentialStore } from "../security/credentials.js";
import type { TuiSettingsValues } from "./settings-values.js";
export function settingsDraft(
  config: {
    defaultProfileId?: string;
    profiles: Record<string, ProviderProfile>;
  },
  registry: ProviderRegistry,
  selection: {
    profile?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
  } = {},
): TuiSettingsValues {
  let profileId = selection.profile;
  if (!profileId && !selection.provider) profileId = config.defaultProfileId;
  if (!profileId && selection.provider) {
    const matches = Object.entries(config.profiles).filter(
      ([, p]) => p.providerId === selection.provider,
    );
    if (matches.length === 1) profileId = matches[0]?.[0];
  }
  const profile = profileId ? config.profiles[profileId] : undefined;
  if (
    profile &&
    selection.provider &&
    profile.providerId !== selection.provider
  )
    throw new Error("--profile and --provider select different providers.");
  const provider =
    profile?.providerId ??
    selection.provider ??
    builtinDefinitions[0]?.id ??
    registry.list()[0]?.id ??
    "";
  const definition = registry.get(provider);
  return {
    provider,
    profileId,
    model:
      selection.model ??
      profile?.defaultModel ??
      definition?.defaults.model ??
      "",
    label: profile?.label,
    baseUrl:
      selection.baseUrl ??
      profile?.baseUrl ??
      (definition?.endpoint.normalization !== "none"
        ? definition?.endpoint.defaultBaseUrl
        : undefined),
  };
}
export async function settingsKeyReady(
  registry: ProviderRegistry,
  profile: ProviderProfile,
  credentials: CredentialsReader = new CredentialStore(),
): Promise<boolean> {
  const d = registry.get(profile.providerId);
  if (!d) return false;
  if (d.auth.type === "subscription")
    return profile.apiKeyRef
      ? (await registry.connection(d.id)?.status(profile.apiKeyRef))
          ?.connected === true
      : false;
  if (!d.auth.required) return true;
  return Boolean(await resolveCredential(d, profile, credentials));
}
export async function saveProviderSettings(
  values: TuiSettingsValues,
  registry: ProviderRegistry,
  options: {
    configPath?: string;
    activate?: boolean;
    updateSelectedModel?: boolean;
    previous?: TuiSettingsValues;
    credentials?: CredentialsReader & {
      set(ref: string, key: string): Promise<void>;
    };
  } = {},
): Promise<"saved" | "setup_required"> {
  const current = await loadGlobalConfig(options.configPath);
  const definition = registry.require(values.provider);
  if (
    !values.profileId &&
    Object.values(current.profiles).filter(
      (profile) => profile.providerId === values.provider,
    ).length > 1
  )
    throw new Error(
      "Multiple profiles; choose a profile or enter a new profile ID.",
    );
  const id = ProfileIdSchema.parse(
    values.profileId ?? `${values.provider.replaceAll("/", "-")}-default`,
  );
  const previous = current.profiles[id];
  if (previous && previous.providerId !== values.provider)
    throw new Error(
      `Profile "${id}" belongs to another provider; choose a new profile ID.`,
    );
  const model = values.model.trim();
  if (!model) throw new Error("Введите модель.");
  const raw = values.baseUrl?.trim();
  const baseUrl = raw
    ? normalizeEndpoint(definition.endpoint.normalization, raw)
    : undefined;
  if (
    definition.endpoint.required &&
    !baseUrl &&
    !definition.endpoint.defaultBaseUrl
  )
    throw new Error("Provider requires baseUrl.");
  const key =
    definition.auth.type === "subscription" ? undefined : values.apiKey?.trim();
  const credentials = options.credentials ?? new CredentialStore();
  let profile: ProviderProfile = {
    ...previous,
    providerId: values.provider,
    baseUrl,
    defaultModel: model,
  };
  await updateGlobalConfig(options.configPath, async (latest) => {
    const existing = latest.profiles[id];
    if (existing && existing.providerId !== values.provider)
      throw new Error(
        `Profile "${id}" belongs to another provider; reload Settings.`,
      );
    const baseline = options.previous;
    if (baseline && !existing)
      throw new Error("Профиль удалён. Обновите список подключений.");
    const fields = {
      defaultModel: model,
      baseUrl,
      label:
        values.label === undefined
          ? existing?.label
          : values.label.trim() || undefined,
    };
    const before = baseline
      ? {
          defaultModel: baseline.model.trim(),
          baseUrl: baseline.baseUrl?.trim()
            ? normalizeEndpoint(
                definition.endpoint.normalization,
                baseline.baseUrl.trim(),
              )
            : undefined,
          label: baseline.label?.trim() || undefined,
        }
      : undefined;
    const patch: Partial<ProviderProfile> = {};
    for (const field of ["defaultModel", "baseUrl", "label"] as const) {
      if (before && fields[field] === before[field]) continue;
      if (
        before &&
        existing?.[field] !== before[field] &&
        existing?.[field] !== fields[field]
      )
        throw new Error(
          `Поле ${field} изменилось в другом окне. Обновите подключение и повторите изменение.`,
        );
      patch[field] = fields[field];
    }
    // A new secret must not change a key already used by a working/shared profile
    // before the config's atomic commit points at the new reference.
    const apiKeyRef =
      definition.auth.type === "subscription"
        ? id
        : key && existing?.apiKeyRef
          ? `${id}-${randomUUID()}`
          : (existing?.apiKeyRef ?? (key ? id : undefined));
    if (key && apiKeyRef) await credentials.set(apiKeyRef, key);
    profile = {
      ...existing,
      providerId: values.provider,
      apiKeyRef,
      ...patch,
    };
    return {
      ...latest,
      defaultProfileId:
        options.activate === false ? latest.defaultProfileId : id,
      profiles: { ...latest.profiles, [id]: profile },
      ui: {
        ...latest.ui,
        lastModelSelection:
          options.activate === false
            ? options.updateSelectedModel &&
              latest.ui?.lastModelSelection?.profileId === id
              ? { ...latest.ui.lastModelSelection, model }
              : latest.ui?.lastModelSelection
            : { provider: values.provider, profileId: id, model },
      },
    };
  });
  return (await settingsKeyReady(registry, profile, credentials))
    ? "saved"
    : "setup_required";
}
export function filterProviderDefinitions(
  registry: ProviderRegistry,
  query: string,
) {
  return registry.search(query);
}
export function selectorWindow<T>(
  items: T[],
  selected: number,
  height: number,
): T[] {
  const start = Math.max(
    0,
    Math.min(selected - 3, Math.max(0, items.length - Math.max(1, height - 7))),
  );
  return items.slice(start, start + Math.max(1, height - 7));
}

/** Remove one account without touching credentials referenced by another profile. */
export async function removeProviderProfile(
  profileId: string,
  registry: ProviderRegistry,
  options: {
    configPath?: string;
    credentials?: CredentialStore;
    expected?: ProviderProfile;
  } = {},
): Promise<void> {
  const credentials = options.credentials ?? new CredentialStore();
  let removed: ProviderProfile | undefined;
  let shared = false;
  await updateGlobalConfig(options.configPath, (latest) => {
    removed = latest.profiles[profileId];
    if (!removed) throw new Error("Профиль уже удалён. Обновите список.");
    if (options.expected && !isDeepStrictEqual(removed, options.expected))
      throw new Error(
        "Профиль изменился. Обновите список и подтвердите удаление заново.",
      );
    const profiles = { ...latest.profiles };
    delete profiles[profileId];
    shared =
      !!removed.apiKeyRef &&
      Object.values(profiles).some(
        (profile) => profile.apiKeyRef === removed?.apiKeyRef,
      );
    const defaultProfileId =
      latest.defaultProfileId === profileId
        ? Object.keys(profiles)[0]
        : latest.defaultProfileId;
    return {
      ...latest,
      profiles,
      defaultProfileId,
      ui: {
        ...latest.ui,
        lastModelSelection:
          latest.ui?.lastModelSelection?.profileId === profileId
            ? undefined
            : latest.ui?.lastModelSelection,
      },
    };
  });
  if (!removed) return;
  await registry.connection(removed.providerId)?.disconnect(profileId);
  if (
    removed.apiKeyRef &&
    !shared &&
    registry.require(removed.providerId).auth.type !== "subscription"
  )
    await credentials.delete(removed.apiKeyRef);
}

/** Keep profile/schema validation in the settings service, outside the renderer import graph. */
export async function connectProviderAccount(
  values: TuiSettingsValues,
  registry: ProviderRegistry,
  signal: AbortSignal,
  challenge: (value: ConnectionChallenge) => void,
  options: { configPath?: string } = {},
) {
  signal.throwIfAborted();
  const profileId = ProfileIdSchema.parse(values.profileId);
  const current = await loadGlobalConfig(options.configPath);
  signal.throwIfAborted();
  if (
    current.profiles[profileId] &&
    current.profiles[profileId]?.providerId !== values.provider
  )
    throw new Error("Профиль принадлежит другому сервису.");
  const connection = registry.connection(values.provider);
  if (!connection)
    throw new Error("Этот сервис не поддерживает вход по подписке.");
  return connection.connect({ profileId, signal, challenge });
}
