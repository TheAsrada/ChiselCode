import { updateGlobalConfig } from "../config/load.js";
import type { GlobalConfig } from "../types/domain.js";
import type { ModelSelection } from "./opentui-models.js";

/** Only an explicit UI choice is remembered; resumed sessions never write it. */
export function rememberedModelOptions(
  config: GlobalConfig,
  explicit: {
    profile?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
  },
) {
  if (
    explicit.profile ||
    explicit.provider ||
    explicit.model ||
    explicit.baseUrl
  )
    return explicit;
  const remembered = config.ui?.lastModelSelection;
  const profile = remembered && config.profiles[remembered.profileId];
  return remembered && profile?.providerId === remembered.provider
    ? { profile: remembered.profileId, model: remembered.model }
    : explicit;
}

export async function rememberModelSelection(
  selection: ModelSelection & { profileId: string },
  configPath?: string,
  assertCurrent: () => void = () => {},
) {
  await updateGlobalConfig(configPath, (latest) => {
    assertCurrent();
    if (latest.profiles[selection.profileId]?.providerId !== selection.provider)
      throw new Error("Подключение изменилось. Откройте выбор модели заново.");
    return {
      ...latest,
      ui: {
        ...latest.ui,
        lastModelSelection: {
          provider: selection.provider,
          profileId: selection.profileId,
          model: selection.model,
        },
      },
    };
  });
}
