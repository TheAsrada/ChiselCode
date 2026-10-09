import { frozenClone } from "../extensions/lifecycle.js";
import type { ModelCapabilities } from "../providers/capabilities.js";
import type {
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import type { DriverRegistry } from "../providers/drivers/index.js";
import { resolveEndpoint } from "../providers/endpoint.js";
import { catalogModelLimits } from "../providers/model-metadata.js";
import { resolveProfileModel, selectProfile } from "../providers/profiles.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { resolveProviderRuntime } from "../providers/runtime.js";
import { CredentialStore } from "../security/credentials.js";
import type { SecretRedactor } from "../security/redaction.js";
import type { GlobalConfig, Session } from "../types/domain.js";
import type { RunOptions } from "./run-prompt.js";

/** Core-only captured configuration. Never included in the extension invocation/DTO. */
export interface CapturedModelConfiguration {
  profileId: string;
  profile: ProviderProfile;
  definition: ProviderDefinition;
  model: string;
  baseUrl?: string;
  capabilities: ModelCapabilities;
}

export function captureModelConfiguration(
  global: GlobalConfig,
  registry: ProviderRegistry,
  options: RunOptions,
  previous?: Pick<Session, "profileId" | "providerId" | "model">,
  capabilities?: ModelCapabilities,
): CapturedModelConfiguration {
  const selected = selectProfile(
    global,
    options.profile || options.provider
      ? { profile: options.profile, provider: options.provider }
      : previous
        ? {
            profile:
              previous.profileId ??
              `${previous.providerId.replaceAll("/", "-")}-default`,
          }
        : {},
  );
  const definition = registry.require(selected.profile.providerId);
  const model =
    previous && !options.model && !options.provider && !options.profile
      ? previous.model
      : resolveProfileModel(selected.profile, registry, options.model);
  return frozenClone({
    ...selected,
    definition,
    model,
    baseUrl: resolveEndpoint(
      definition,
      options.baseUrl ?? selected.profile.baseUrl,
    ),
    capabilities: capabilities ?? {
      tokenCounting:
        definition.capabilities.tokenCounting === "native"
          ? "provider"
          : "local_estimate",
      ...catalogModelLimits(definition.id, model),
    },
  });
}

export async function resolveCapturedModelRuntime(
  capture: CapturedModelConfiguration,
  drivers: DriverRegistry,
  redactor: SecretRedactor,
) {
  const credentials = new CredentialStore();
  for (const name of capture.definition.auth.envVars) {
    const value = process.env[name]?.trim();
    if (value) redactor.add(value);
  }
  return resolveProviderRuntime({
    profile: capture.profile,
    profileId: capture.profileId,
    definition: capture.definition,
    drivers,
    baseUrl: capture.baseUrl,
    credentials: {
      get: async (ref) => {
        const value = await credentials.get(ref);
        if (value) redactor.add(value);
        return value;
      },
    },
  });
}

/** Metadata-only fallback allows saved task inspection after a profile was removed. */
export function captureUnavailableModel(
  registry: ProviderRegistry,
  session: Session,
): CapturedModelConfiguration {
  const source = registry.get(session.providerId) ?? registry.list()[0];
  if (!source) throw new Error("Нет описания сервиса модели.");
  return frozenClone({
    profileId: session.profileId,
    profile: { providerId: source.id },
    definition: {
      ...source,
      capabilities: { ...source.capabilities, toolCalling: false },
    },
    model: session.model,
    capabilities: { tokenCounting: "local_estimate" },
  });
}
