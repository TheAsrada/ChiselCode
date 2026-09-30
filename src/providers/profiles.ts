import type { ConfigV2 } from "../config/schema.js";
import type { ProviderProfile } from "./contracts.js";
import { ProviderError } from "./errors.js";
import type { ProviderRegistry } from "./registry.js";
export function selectProfile(
  config: Pick<ConfigV2, "profiles" | "defaultProfileId">,
  selection: { profile?: string; provider?: string } = {},
): { profileId: string; profile: ProviderProfile } {
  if (selection.profile) {
    const profile = config.profiles[selection.profile];
    if (!profile)
      throw new ProviderError(
        "bad_request",
        `Profile "${selection.profile}" is not configured. Run chisel setup.`,
      );
    if (selection.provider && selection.provider !== profile.providerId)
      throw new ProviderError(
        "bad_request",
        "--profile and --provider select different providers.",
      );
    return { profileId: selection.profile, profile };
  }
  if (selection.provider) {
    const found = Object.entries(config.profiles).filter(
      ([, p]) => p.providerId === selection.provider,
    );
    if (found.length !== 1)
      throw new ProviderError(
        "bad_request",
        found.length
          ? `Provider "${selection.provider}" has multiple profiles; specify --profile.`
          : `Provider "${selection.provider}" is not configured. Run chisel setup.`,
      );
    const [profileId, profile] = found[0] as [string, ProviderProfile];
    return { profileId, profile };
  }
  if (config.defaultProfileId)
    return selectProfile(config, { profile: config.defaultProfileId });
  throw new ProviderError(
    "bad_request",
    "Default profile is not configured. Run chisel setup.",
  );
}
export function resolveProfileModel(
  profile: ProviderProfile,
  registry: ProviderRegistry,
  explicit?: string,
): string {
  const model =
    explicit ??
    profile.defaultModel ??
    registry.require(profile.providerId).defaults.model;
  if (!model)
    throw new ProviderError(
      "bad_request",
      `Choose a model for provider "${profile.providerId}" using --model or setup.`,
    );
  return model;
}
