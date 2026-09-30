import type { GlobalConfig, ProviderConfig } from "../types/domain.js";
import {
  type ConfigV2,
  GlobalConfigV2Schema,
  LegacyConfigSchema,
} from "./schema.js";
export function migrateConfig(raw: unknown): ConfigV2 {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as { schemaVersion?: number }).schemaVersion === 2
  )
    return GlobalConfigV2Schema.parse(raw);
  const legacy = LegacyConfigSchema.parse(raw);
  const {
    providers,
    defaultProvider,
    defaultModel,
    schemaVersion: _version,
    ...rest
  } = legacy;
  const profiles: ConfigV2["profiles"] = {};
  for (const [providerId, value] of Object.entries(providers)) {
    const { provider: _id, ...fields } = value;
    profiles[`${providerId.replaceAll("/", "-")}-default`] = {
      ...fields,
      providerId,
    };
  }
  const defaultProfileId = defaultProvider
    ? `${defaultProvider.replaceAll("/", "-")}-default`
    : undefined;
  if (defaultProvider && defaultProfileId) {
    profiles[defaultProfileId] ??= { providerId: defaultProvider };
    if (defaultModel && !profiles[defaultProfileId].defaultModel)
      profiles[defaultProfileId].defaultModel = defaultModel;
  }
  return GlobalConfigV2Schema.parse({
    ...rest,
    schemaVersion: 2,
    defaultProfileId,
    profiles,
  });
}
/** Temporary non-persisted accessors while callers migrate to profiles. */
export function withLegacyAccessors(config: ConfigV2): GlobalConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const profile of Object.values(config.profiles)) {
    providers[profile.providerId] ??= {
      ...profile,
      provider: profile.providerId,
    };
  }
  Object.defineProperties(config, {
    providers: { value: providers, enumerable: false },
    defaultProvider: {
      value: config.defaultProfileId
        ? config.profiles[config.defaultProfileId]?.providerId
        : undefined,
      enumerable: false,
    },
    defaultModel: {
      value: config.defaultProfileId
        ? config.profiles[config.defaultProfileId]?.defaultModel
        : undefined,
      enumerable: false,
    },
  });
  return config as GlobalConfig;
}
export function normalizeConfigForSave(raw: unknown): ConfigV2 {
  if (!raw || typeof raw !== "object") return migrateConfig(raw);
  const input = raw as Record<string, unknown>;
  // Legacy caller updates are explicit enumerable fields; accessors from load are not writes.
  if (
    input.schemaVersion === 2 &&
    Object.prototype.propertyIsEnumerable.call(input, "providers")
  ) {
    const legacy = migrateConfig({ ...input, schemaVersion: undefined });
    const {
      providers: _providers,
      defaultProvider: _provider,
      defaultModel: _model,
      ...rest
    } = input;
    return GlobalConfigV2Schema.parse({
      ...rest,
      profiles: {
        ...(input.profiles as ConfigV2["profiles"]),
        ...legacy.profiles,
      },
      defaultProfileId: legacy.defaultProfileId ?? input.defaultProfileId,
    });
  }
  return migrateConfig(raw);
}
