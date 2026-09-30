import { loadGlobalConfig, saveGlobalConfig } from "../src/config/load.js";
import type { ProviderProfile } from "../src/providers/contracts.js";
import { selectProfile } from "../src/providers/profiles.js";
export async function writeTrialProviderConfig(
  path: string,
  providerId: string,
  model: string,
  profileId?: string,
  userConfigPath?: string,
): Promise<void> {
  const config = await loadGlobalConfig(userConfigPath);
  let profile: ProviderProfile;
  const matching = Object.values(config.profiles).filter(
    (p) => p.providerId === providerId,
  );
  if (profileId || matching.length) {
    profile = {
      ...selectProfile(config, { provider: providerId, profile: profileId })
        .profile,
    };
  } else profile = { providerId };
  await saveGlobalConfig(
    {
      schemaVersion: 2,
      defaultProfileId: "eval-trial",
      profiles: { "eval-trial": { ...profile, defaultModel: model } },
    },
    path,
  );
}
