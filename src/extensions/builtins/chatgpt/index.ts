import type { ProviderDefinition } from "../../../providers/contracts.js";
import { ProviderError } from "../../../providers/errors.js";
import type { ChiselExtension } from "../../contracts.js";
import type { UiBinding, UiSnapshot } from "../../ui-types.js";
import { ChatGptAdapter } from "./adapter.js";
import { ChatGptAuth, type ChatGptAuthOptions } from "./auth.js";
import { ChatGptTransport } from "./transport.js";
import { ChatGptUsage, usageUi } from "./usage.js";

export const chatGptDefinition: ProviderDefinition = {
  id: "chatgpt",
  label: "ChatGPT",
  description: "Подписка ChatGPT · вход по коду",
  driverId: "chatgpt-responses",
  auth: { type: "subscription", required: true, envVars: [] },
  endpoint: {
    required: false,
    normalization: "none",
    defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
  },
  defaults: {},
  capabilities: {
    modelListing: true,
    tokenCounting: "unsupported",
    usageReporting: "final",
    toolCalling: true,
    thinking: true,
  },
};
export function createChatGptExtension(
  options: ChatGptAuthOptions = {},
): ChiselExtension {
  const auth = new ChatGptAuth(options);
  const transport = new ChatGptTransport(auth, options.fetch);
  const usage = new ChatGptUsage(transport);
  return {
    id: "builtin.chatgpt",
    providers: [
      {
        definition: chatGptDefinition,
        connection: {
          status: (id) => auth.status(id),
          connect: async (input) => {
            const status = await auth.connect(input);
            usage.clear(input.profileId);
            return status;
          },
          disconnect: async (id) => {
            await auth.disconnect(id);
            usage.clear(id);
          },
        },
        create(context) {
          if (
            context.baseUrl &&
            context.baseUrl !== chatGptDefinition.endpoint.defaultBaseUrl
          )
            throw new ProviderError(
              "invalid_endpoint",
              "Адрес подключения подписки ChatGPT фиксирован.",
            );
          if (!context.profileId)
            throw new ProviderError(
              "authentication",
              "Выберите профиль ChatGPT.",
            );
          return new ChatGptAdapter(context.profileId, transport, usage);
        },
      },
    ],
    activate(ctx) {
      let revision = 0;
      const profile = (binding: UiBinding) => {
        const selection = binding.read.ownerSummary().modelSelection;
        return selection?.provider === chatGptDefinition.id
          ? selection.profileId
          : undefined;
      };
      const snapshot = (binding: UiBinding): UiSnapshot => {
        const id = profile(binding);
        const status = id ? auth.knownStatus(id) : undefined;
        if (!id || status?.connected === false)
          return {
            revision: ++revision,
            state: "empty" as const,
            visible: false,
          };
        const cached = usage.peek(id);
        return cached
          ? { ...usageUi(cached), revision: ++revision }
          : {
              revision: ++revision,
              state: "loading" as const,
              label: "Получаем лимиты…",
            };
      };
      const source = {
        snapshot,
        subscribe(binding: UiBinding, changed: () => void) {
          const lifetime = new AbortController();
          let operation: AbortController | undefined;
          let currentProfile: string | undefined;
          const refresh = async () => {
            if (lifetime.signal.aborted) return;
            const id = profile(binding);
            if (operation && currentProfile === id) return;
            operation?.abort();
            if (!id) {
              operation = undefined;
              changed();
              return;
            }
            const pending = new AbortController();
            operation = pending;
            currentProfile = id;
            const signal = AbortSignal.any([
              binding.signal,
              lifetime.signal,
              pending.signal,
            ]);
            try {
              const status = await auth.status(id);
              if (signal.aborted) return;
              changed();
              if (status.connected) await usage.read(id, signal);
            } catch {
              if (!signal.aborted) usage.unavailable(id);
            } finally {
              if (operation === pending) operation = undefined;
            }
          };
          const owner = binding.read.subscribeOwner(() => {
            changed();
            void refresh();
          });
          const updates = usage.subscribe(() => {
            changed();
            const id = profile(binding);
            if (id && !usage.peek(id)) void refresh();
          });
          const timer = setInterval(() => {
            changed();
            void refresh();
          }, 60_000);
          timer.unref?.();
          void refresh();
          return {
            dispose() {
              lifetime.abort();
              clearInterval(timer);
              owner.dispose();
              updates.dispose();
            },
          };
        },
      };
      const actions = [
        {
          id: "details",
          label: "Лимиты подписки",
          type: "view" as const,
          viewId: "limits",
        },
      ];
      ctx.ui.register({
        id: "limits",
        slot: "context_section",
        scope: "conversation",
        title: "ChatGPT",
        order: 5,
        actions,
        source,
      });
      ctx.ui.registerView({
        id: "limits",
        scope: "conversation",
        title: "Подписка ChatGPT",
        page(binding) {
          const value = snapshot(binding);
          return {
            revision: value.revision,
            state: value.state,
            summary: value.detail ?? value.label ?? "Выбран другой профиль",
            rows: value.rows,
          };
        },
        subscribe: source.subscribe,
      });
    },
  };
}
/** Shared application instance: catalog, connections and workspace UI use the same account cache. */
export const chatGptExtension = createChatGptExtension();
