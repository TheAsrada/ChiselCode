import { type RunOptions } from "../commands/run.js";
import { loadGlobalConfig } from "../config/load.js";
import type { getProviderCatalog } from "../providers/catalog.js";
import { selectProfile } from "../providers/profiles.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { ModelCatalogController } from "./model-catalog-controller.js";
import { rememberModelSelection } from "./model-preference.js";
import type { OpenTuiModelsActions } from "./opentui-models.js";
import { settingsDraft } from "./provider-settings.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";

export function createModelSelectionActions({
  currentController,
  catalog,
  modelOptions,
  modelCatalog,
  abort,
  saves,
  modelSelected,
  warmModelCapabilities,
  options,
}: {
  currentController: () => TuiController;
  catalog: Awaited<ReturnType<typeof getProviderCatalog>>;
  modelOptions: (controller: TuiController) => RunOptions;
  modelCatalog: ModelCatalogController;
  abort: AbortController;
  saves: { pending: Promise<void> };
  modelSelected: (model: string) => void;
  warmModelCapabilities: (controller: TuiController) => void;
  options: RunOptions;
}) {
  const getModelsActions = (): OpenTuiModelsActions => {
    const controller = currentController();
    const generation = controller.currentGeneration;
    return {
      load: async () => {
        const currentConfig = await loadGlobalConfig(options.configPath);
        const current =
          controller.snapshot.modelSelection ??
          settingsDraft(
            currentConfig,
            catalog.registry,
            modelOptions(controller),
          );
        const profiles = Object.entries(currentConfig.profiles).flatMap(
          ([id, entry]) => {
            const provider = catalog.registry.get(entry.providerId);
            if (!provider) return [];
            return [
              {
                key: id,
                label: entry.label ?? id,
                providerLabel: provider.label,
                selection: settingsDraft(currentConfig, catalog.registry, {
                  profile: id,
                }),
              },
            ];
          },
        );
        const matching = profiles.find(
          (item) =>
            item.selection.profileId === current.profileId &&
            item.selection.provider === current.provider,
        );
        if (matching) matching.selection = { ...current };
        return { current: { ...current }, profiles };
      },
      models: (selection, refresh) => modelCatalog.models(selection, refresh),
      select: async (selection) => {
        if (abort.signal.aborted || !controller.isCurrent(generation))
          throw new Error("Эта сессия уже закрыта.");
        const currentConfig = await loadGlobalConfig(options.configPath);
        if (abort.signal.aborted || !controller.isCurrent(generation))
          throw new Error("Эта сессия уже закрыта.");
        catalog.registry.require(selection.provider);
        const { profileId } = selectProfile(currentConfig, {
          provider: selection.provider,
          profile: selection.profileId,
        });
        if (
          !selection.model.trim() ||
          [...selection.model].some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new Error("Введите корректный ID модели.");
        const { sessionId, projectPath, busy } = controller.snapshot;
        if (sessionId && !busy && projectPath) {
          const saved = saves.pending.then(async () => {
            const store = await projectSessionStore(projectPath);
            if (abort.signal.aborted || !controller.isCurrent(generation))
              throw new Error("Эта сессия уже закрыта.");
            await store.setPreferences(sessionId, {
              providerId: selection.provider,
              profileId,
              model: selection.model,
            });
          });
          saves.pending = saved.catch(() => {});
          await saved;
        }
        await rememberModelSelection(
          { ...selection, profileId },
          options.configPath,
          () => {
            if (abort.signal.aborted || !controller.isCurrent(generation))
              throw new Error("Эта сессия уже закрыта.");
          },
        );
        if (abort.signal.aborted || !controller.isCurrent(generation)) return;
        controller.setActiveModel(
          selection.provider,
          selection.model,
          profileId,
          selection.baseUrl,
        );
        modelSelected(selection.model);
        warmModelCapabilities(controller);
      },
    };
  };
  return { getModelsActions };
}
