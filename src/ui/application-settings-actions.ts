import { BackgroundSettingsStore } from "../background/settings.js";
import {
  checkProviderConnection,
  listProviderModels,
  type RunOptions,
} from "../commands/run.js";
import {
  loadGlobalConfig,
  loadProjectConfig,
  updateGlobalConfig,
} from "../config/load.js";
import { subagentServiceToken } from "../extensions/builtins/subagents.js";
import { type ExtensionHost } from "../extensions/host.js";
import { ExtensionManagementService } from "../extensions/management.js";
import { lspServiceToken } from "../lsp/service.js";
import { LspSettingsStore } from "../lsp/settings.js";
import type { getProviderCatalog } from "../providers/catalog.js";
import { SecretRedactor } from "../security/redaction.js";
import { effectiveSubagentConfig } from "../subagents/config.js";
import { SubagentSettingsStore } from "../subagents/settings.js";
import type { GlobalConfig } from "../types/domain.js";
import type { resolveWebConfig } from "../web/schema.js";
import { WebSettingsStore } from "../web/settings.js";
import type { UiToolSubmit } from "./extension-ui.js";
import { ModelCatalogController } from "./model-catalog-controller.js";
import {
  connectProviderAccount,
  removeProviderProfile,
  saveProviderSettings,
  settingsDraft,
  settingsKeyReady,
} from "./provider-settings.js";
import type { OpenTuiSettingsActions } from "./settings-contracts.js";
import { FAIL_MARK, OK_MARK } from "./theme.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";

export interface ApplicationPreferences {
  activeOptions: RunOptions;
  config: GlobalConfig;
  defaultModel: string;
  webConfigLive: ReturnType<typeof resolveWebConfig>;
}

export function createApplicationSettingsActions({
  currentController,
  requireProject,
  submitUiTool,
  extensionManagement,
  webSettingsStore,
  saves,
  preferences,
  catalog,
  modelOptions,
  uiRedactor,
  modelCatalog,
  warmModelCapabilities,
  options,
  extensionHost,
}: {
  currentController: () => TuiController;
  requireProject: (controller?: TuiController) => string;
  submitUiTool: UiToolSubmit;
  extensionManagement: ExtensionManagementService;
  webSettingsStore: WebSettingsStore;
  saves: { pending: Promise<void> };
  preferences: ApplicationPreferences;
  catalog: Awaited<ReturnType<typeof getProviderCatalog>>;
  modelOptions: (controller: TuiController) => RunOptions;
  uiRedactor: SecretRedactor;
  modelCatalog: ModelCatalogController;
  warmModelCapabilities: (controller: TuiController) => void;
  options: RunOptions;
  extensionHost: ExtensionHost;
}) {
  const getSettingsActions = (): OpenTuiSettingsActions => {
    const owner = currentController();
    const generation = owner.currentGeneration;
    const root = owner.snapshot.projectPath;
    const lsp = new LspSettingsStore(root, options.configPath, {
      launchRestriction: () =>
        owner.snapshot.agentMode === "plan"
          ? "Режим Plan: явный запуск доступен в Build. Анализ чтения запускается при запросе к файлу."
          : undefined,
      assertOwner: () => {
        if (
          !owner.isCurrent(generation) ||
          owner.snapshot.projectPath !== root ||
          owner.ownerSignal.aborted
        )
          throw new Error("Проект изменён; откройте меню анализа заново.");
      },
      status: async () => {
        try {
          const scope = extensionHost
            .readyScopes()
            .find((s) => s.workspaceRoot === root);
          const service = scope?.services.lookup(lspServiceToken);
          if (service) return service.status();
        } catch {
          /* Existing navigation stays available if an extension activation fails. */
        }
        return {
          workspaceRoot: requireProject(owner),
          backend: "typescript",
          state: "unavailable",
          generation: 0,
          trackedDocuments: 0,
          requiresRestart: false,
          reason: "LSP extension недоступен в этой composition.",
        };
      },
      apply: async () => {
        await Promise.all(
          extensionHost
            .readyScopes()
            .map((scope) =>
              scope.services.lookup(lspServiceToken)?.refreshConfiguration(),
            ),
        );
      },
      entries: () =>
        extensionHost
          .readyScopes()
          .find((scope) => scope.workspaceRoot === root)
          ?.services.lookup(lspServiceToken)
          ?.managementEntries() ?? [],
      subscribe: (changed) =>
        extensionHost
          .readyScopes()
          .find((scope) => scope.workspaceRoot === root)
          ?.services.lookup(lspServiceToken)
          ?.subscribeUi(changed) ?? { dispose() {} },
      restart: async (id) => {
        if (
          !owner.isCurrent(generation) ||
          owner.snapshot.projectPath !== root ||
          owner.ownerSignal.aborted
        )
          return {
            output: "Проект изменён; откройте меню анализа заново.",
            isError: true,
            errorCode: "CANCELLED",
          };
        try {
          const scope = await extensionHost.open(requireProject(owner));
          if (
            !owner.isCurrent(generation) ||
            owner.snapshot.projectPath !== root
          )
            throw new Error("Владелец действия изменён.");
          return await submitUiTool(
            owner,
            scope,
            "builtin.lsp",
            "restart",
            id ? { serverId: id } : {},
          );
        } catch (error) {
          return {
            output:
              error instanceof Error
                ? error.message
                : "Не удалось выполнить перезапуск LSP.",
            isError: true,
            errorCode: "TOOL_EXECUTION_FAILURE",
          };
        }
      },
    });
    return {
      extensions: extensionManagement,
      background: new BackgroundSettingsStore(root, options.configPath),
      subagents: new SubagentSettingsStore(
        root,
        options.configPath,
        async () => {
          const global = await loadGlobalConfig(options.configPath);
          for (const scope of extensionHost.readyScopes()) {
            const project = await loadProjectConfig(scope.workspaceRoot);
            await scope.services
              .lookup(subagentServiceToken)
              ?.applyConfiguration(
                scope.workspaceRoot,
                effectiveSubagentConfig(global.subagents, project.subagents),
              );
          }
        },
      ),
      lsp,
      workspaceRoot: root,
      web: {
        load: () => webSettingsStore.load(),
        save: async (webConfig, apiKey) => {
          const saved = saves.pending.then(async () => {
            const state = await webSettingsStore.save(webConfig, apiKey);
            preferences.webConfigLive = state.config;
            return state;
          });
          saves.pending = saved.then(
            () => {},
            () => {},
          );
          return saved;
        },
      },
      catalog: async () => ({
        providers: catalog.registry.list(),
        profiles: (await loadGlobalConfig(options.configPath)).profiles,
      }),
      load: async (profileId) => {
        const current = await loadGlobalConfig(options.configPath);
        const selection = profileId
          ? { profile: profileId }
          : modelOptions(owner);
        const values = settingsDraft(current, catalog.registry, selection);
        const profile = values.profileId
          ? current.profiles[values.profileId]
          : undefined;
        return {
          values,
          hasKey: await settingsKeyReady(
            catalog.registry,
            profile ?? { providerId: values.provider },
          ),
          accountLabel: values.profileId
            ? (
                await catalog.registry
                  .connection(values.provider)
                  ?.status(values.profileId)
              )?.label
            : undefined,
        };
      },
      hasKey: async (provider, profileId) => {
        const current = await loadGlobalConfig(options.configPath);
        return settingsKeyReady(
          catalog.registry,
          profileId
            ? (current.profiles[profileId] ?? { providerId: provider })
            : {
                providerId: provider,
                apiKeyRef:
                  catalog.registry.get(provider)?.auth.type === "subscription"
                    ? profileId
                    : undefined,
              },
        );
      },
      save: async (values, previous) => {
        if (values.apiKey?.trim()) uiRedactor.add(values.apiKey.trim());
        const outcome = await saveProviderSettings(values, catalog.registry, {
          configPath: options.configPath,
          activate: false,
          updateSelectedModel:
            owner.isCurrent(generation) &&
            owner.snapshot.modelSelection?.profileId === values.profileId,
          previous,
        });
        preferences.config = await loadGlobalConfig(options.configPath);
        modelCatalog.invalidate();
        if (
          owner.isCurrent(generation) &&
          owner.snapshot.modelSelection?.profileId === values.profileId
        ) {
          owner.setActiveModel(
            values.provider,
            values.model,
            values.profileId,
            values.baseUrl,
          );
          if (preferences.activeOptions.profile === values.profileId) {
            preferences.activeOptions = {
              ...preferences.activeOptions,
              model: values.model,
              baseUrl: values.baseUrl,
            };
            preferences.defaultModel = values.model;
          }
          warmModelCapabilities(owner);
        }
        return outcome;
      },
      activate: async (values) => {
        await updateGlobalConfig(options.configPath, (latest) => {
          if (!owner.isCurrent(generation))
            throw new Error("Беседа изменилась. Откройте настройки заново.");
          if (
            !values.profileId ||
            latest.profiles[values.profileId]?.providerId !== values.provider
          )
            throw new Error("Подключение изменилось. Обновите список.");
          return {
            ...latest,
            defaultProfileId: values.profileId,
            ui: {
              ...latest.ui,
              lastModelSelection: {
                provider: values.provider,
                profileId: values.profileId,
                model: values.model,
              },
            },
          };
        });
        preferences.config = await loadGlobalConfig(options.configPath);
        preferences.defaultModel = values.model;
        const profile =
          values.profileId ?? `${values.provider.replaceAll("/", "-")}-default`;
        preferences.activeOptions = {
          ...preferences.activeOptions,
          profile,
          provider: undefined,
          model: values.model,
          baseUrl: values.baseUrl,
        };
        modelCatalog.invalidate();
        if (!owner.isCurrent(generation)) return;
        owner.setActiveModel(
          values.provider,
          values.model,
          profile,
          values.baseUrl,
        );
        warmModelCapabilities(owner);
        return;
      },
      connect: (values, signal, challenge) =>
        connectProviderAccount(values, catalog.registry, signal, challenge, {
          configPath: options.configPath,
        }),
      disconnect: async (values) => {
        if (!values.profileId) throw new Error("Выберите профиль.");
        await catalog.registry
          .connection(values.provider)
          ?.disconnect(values.profileId);
        modelCatalog.invalidate();
      },
      removeProfile: async (profileId, expected) => {
        await removeProviderProfile(profileId, catalog.registry, {
          configPath: options.configPath,
          expected,
        });
        preferences.config = await loadGlobalConfig(options.configPath);
        if (
          owner.isCurrent(generation) &&
          owner.snapshot.modelSelection?.profileId === profileId
        ) {
          const next = settingsDraft(preferences.config, catalog.registry);
          preferences.defaultModel = next.model;
          preferences.activeOptions = {
            ...preferences.activeOptions,
            profile: next.profileId,
            provider: undefined,
            model: next.model,
            baseUrl: next.baseUrl,
          };
          owner.setActiveModel(
            next.provider,
            next.model,
            next.profileId,
            next.baseUrl,
          );
        }
        modelCatalog.invalidate();
      },
      check: async (values) => {
        const result = await checkProviderConnection(values, {
          configPath: options.configPath,
        });
        return `${result.ok ? OK_MARK : FAIL_MARK} ${result.message}`;
      },
      models: async (values) => {
        const result = await listProviderModels(values, {
          configPath: options.configPath,
        });
        return result.ok
          ? {
              ok: true,
              models: result.models.map(({ id, displayName }) => ({
                id,
                hint: displayName,
              })),
            }
          : { ok: false, error: result.error };
      },
    };
  };
  return { getSettingsActions };
}
