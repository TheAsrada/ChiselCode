import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { ProfileIdSchema } from "../config/schema.js";
import {
  type CredentialsReader,
  resolveCredential,
} from "../providers/auth.js";
import type { ProviderProfile } from "../providers/contracts.js";
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
    profileId:
      profileId ??
      (Object.values(config.profiles).filter((p) => p.providerId === provider)
        .length > 1
        ? undefined
        : `${provider.replaceAll("/", "-")}-default`),
    model:
      selection.model ??
      profile?.defaultModel ??
      definition?.defaults.model ??
      "",
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
  if (!d.auth.required) return true;
  return Boolean(await resolveCredential(d, profile, credentials));
}
export async function saveProviderSettings(
  values: TuiSettingsValues,
  registry: ProviderRegistry,
  options: {
    configPath?: string;
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
  const key = values.apiKey?.trim();
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
    const apiKeyRef = existing?.apiKeyRef ?? (key ? id : undefined);
    if (key && apiKeyRef) await credentials.set(apiKeyRef, key);
    profile = {
      ...existing,
      providerId: values.provider,
      apiKeyRef,
      baseUrl,
      defaultModel: model,
    };
    return {
      ...latest,
      defaultProfileId: id,
      profiles: { ...latest.profiles, [id]: profile },
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
