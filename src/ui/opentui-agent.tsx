/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import {
  checkProviderConnection,
  hasApiKey,
  listProviderModels,
  type RunOptions,
  runPrompt,
} from "../commands/run.js";
import { loadGlobalConfig, saveGlobalConfig } from "../config/load.js";
import { normalizeBaseUrlForProvider } from "../providers/base-url.js";
import { CredentialStore } from "../security/credentials.js";
import { projectSessionStore } from "../sessions/project-store.js";
import type { GlobalConfig, Session } from "../types/domain.js";
import { resolveProjectDir } from "../utils/paths.js";
import type { OpenTuiSessionsActions } from "./opentui-sessions.js";
import type { OpenTuiSettingsActions } from "./opentui-settings.js";
import { OpenTuiSpike } from "./opentui-spike.js";
import { defaultModelFor } from "./setup.js";
import {
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "./tool-transcript.js";
import { createTuiApprovalResolver } from "./tui.js";
import { TuiController } from "./tui-controller.js";

/** Developer-only agent path; regular CLI continues through the existing renderer. */
export async function runOpenTuiAgent(
  options: RunOptions,
  initialSession?: Session,
): Promise<void> {
  let activeOptions = { ...options, resume: initialSession?.id };
  const controller = new TuiController(options.cwd ?? process.cwd());
  if (initialSession) {
    controller.switchSession(initialSession);
    replaySessionIntoTranscript(controller, initialSession);
    controller.setSessionUsage(initialSession);
  } else controller.refreshGitChanges();
  const approvalResolver = createTuiApprovalResolver();
  const config = await loadGlobalConfig();
  const classic =
    process.env.CHISEL_ALT_SCREEN === "0" ||
    process.env.CHISEL_NO_ALT_SCREEN === "1";
  const renderer = await createCliRenderer({
    screenMode: classic ? "split-footer" : "alternate-screen",
    footerHeight: 12,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);
  const abort = new AbortController();
  let activeRun: Promise<void> | undefined;
  const pendingPrompts: string[] = [];
  let pendingSave: Promise<void> = Promise.resolve();
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = () => {
    abort.abort();
    approvalResolver.dispose();
    finish?.();
  };
  const sessionStore = () =>
    projectSessionStore(activeOptions.cwd ?? process.cwd());
  const resume = async (ref: string): Promise<void> => {
    const store = await sessionStore();
    const session = await store.load((await store.resolve(ref)).id);
    activeOptions = { ...activeOptions, resume: session.id };
    controller.switchSession(session);
    replaySessionIntoTranscript(controller, session);
    controller.setSessionUsage(session);
  };
  const sessionPicker: OpenTuiSessionsActions = {
    load: async () => (await sessionStore()).list(),
    preview: async (id) => (await sessionStore()).load(id),
    resume,
    rename: async (id, title) => {
      const store = await sessionStore();
      await store.rename(id, title);
      if (activeOptions.resume === id)
        controller.setSessionUsage(await store.load(id));
    },
    delete: async (id) => {
      await (await sessionStore()).delete(id);
      if (activeOptions.resume === id) {
        activeOptions = { ...activeOptions, resume: undefined };
        controller.switchSession();
      }
    },
    activeId: () => activeOptions.resume,
  };
  const settingsActions: OpenTuiSettingsActions = {
    load: async () => {
      const current = await loadGlobalConfig();
      const provider =
        activeOptions.provider ?? current.defaultProvider ?? "anthropic";
      const selected = current.providers[provider];
      return {
        values: {
          provider,
          model:
            activeOptions.model ??
            selected?.defaultModel ??
            current.defaultModel ??
            defaultModelFor(provider),
          baseUrl: activeOptions.baseUrl ?? selected?.baseUrl,
        },
        hasKey: await hasApiKey(provider, selected?.apiKeyRef),
      };
    },
    hasKey: async (provider) => {
      const current = await loadGlobalConfig();
      return hasApiKey(provider, current.providers[provider]?.apiKeyRef);
    },
    save: async (values) => {
      const current = await loadGlobalConfig();
      const previous = current.providers[values.provider];
      const typedKey = values.apiKey?.trim();
      const keyRef = typedKey
        ? (previous?.apiKeyRef ?? `${values.provider}-default`)
        : previous?.apiKeyRef;
      if (typedKey && keyRef) await new CredentialStore().set(keyRef, typedKey);
      const baseUrl =
        values.provider === "anthropic-compatible" ||
        values.provider === "openai-compatible" ||
        values.provider === "agentrouter"
          ? normalizeBaseUrlForProvider(values.provider, values.baseUrl)
          : undefined;
      const next: GlobalConfig = {
        ...current,
        defaultProvider: values.provider,
        defaultModel: values.model,
        providers: {
          ...current.providers,
          [values.provider]: {
            provider: values.provider,
            apiKeyRef: keyRef,
            defaultModel: values.model,
            baseUrl,
          },
        },
      };
      await saveGlobalConfig(next);
      activeOptions = {
        ...activeOptions,
        provider: values.provider,
        model: values.model,
        baseUrl,
      };
      controller.setActiveModel(values.provider, values.model);
      return (await hasApiKey(values.provider, keyRef))
        ? "saved"
        : "setup_required";
    },
    check: async (values) => {
      const result = await checkProviderConnection(values);
      return `${result.ok ? "✓" : "✗"} ${result.message}`;
    },
    models: async (values) => {
      const result = await listProviderModels(values);
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
  const submit = async (input: string): Promise<void> => {
    if (abort.signal.aborted) return;
    if (input === "/exit") return shutdown();
    if (activeRun) {
      pendingPrompts.push(input);
      controller.append(
        `В очереди: ${pendingPrompts.length} · ${input}`,
        "info",
      );
      return;
    }
    if (input === "/clear") {
      activeOptions = { ...activeOptions, resume: undefined };
      controller.switchSession();
      return;
    }
    if (input === "/help") {
      controller.append(
        "/clear · /sessions · /resume <id> · /cwd <путь> · /sidebar [auto|show|hide] · /exit",
        "info",
      );
      return;
    }
    if (input === "/sessions") {
      const sessions = await sessionPicker.load();
      controller.append(
        sessions
          .map((s) => `${s.id} · ${s.title ?? "без названия"}`)
          .join("\n") || "Сессий нет",
        "info",
      );
      return;
    }
    if (input.startsWith("/resume ")) {
      try {
        await resume(input.slice(8).trim());
      } catch (error) {
        controller.append(String(error), "error");
      }
      return;
    }
    if (input.startsWith("/cwd ")) {
      try {
        const cwd = await resolveProjectDir(
          input.slice(5).trim(),
          activeOptions.cwd ?? process.cwd(),
        );
        activeOptions = { ...activeOptions, cwd, resume: undefined };
        controller.switchSession(undefined, cwd);
        controller.append(`Проект: ${cwd}`, "info");
      } catch (error) {
        controller.append(String(error), "error");
      }
      return;
    }
    if (input.startsWith("/")) {
      controller.append(
        `Команда ${input.split(" ")[0]} ещё не перенесена в OpenTUI`,
        "warn",
      );
      return;
    }
    controller.append(`❯ ${input}`, "user");
    const tools = toolTranscriptHandlers(() => controller);
    const work = (async () => {
      try {
        let hasText = false;
        const { result } = await runPrompt(
          input,
          activeOptions,
          approvalResolver,
          {
            onText: (text) => {
              controller.appendToLast(text);
              hasText = true;
            },
            onThinking: (text) =>
              controller.setToolActivity(`Размышление: ${text.slice(-200)}`),
            onToolStart: tools.onToolStart,
            onToolResult: (name, outcome) => {
              tools.onToolResult?.(name, outcome);
              if (
                [
                  "write_file",
                  "edit_file",
                  "delete_file",
                  "run_shell",
                  "git_commit",
                ].includes(name)
              )
                controller.refreshGitChanges();
            },
          },
          abort.signal,
        );
        activeOptions = { ...activeOptions, resume: result.session.id };
        controller.setSessionUsage(result.session);
        controller.setToolActivity();
        if (result.error) controller.append(result.error, "error");
        else if (!hasText)
          controller.append(
            result.text || "Запрос завершён без текстового ответа",
            "assistant",
          );
      } catch (error) {
        if (!abort.signal.aborted) controller.append(String(error), "error");
      } finally {
        activeRun = undefined;
        const next = pendingPrompts.shift();
        if (next && !abort.signal.aborted) void submit(next);
      }
    })();
    activeRun = work;
    await work;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    root.render(
      React.createElement(OpenTuiSpike, {
        onExit: shutdown,
        controller,
        approvalResolver,
        sessionPicker,
        settingsActions,
        onSubmit: submit,
        initialMode: config.ui?.sidebarMode ?? "auto",
        onModeChange: (mode) => {
          pendingSave = pendingSave
            .then(async () => {
              const current = await loadGlobalConfig();
              await saveGlobalConfig({
                ...current,
                ui: { ...current.ui, sidebarMode: mode },
              });
            })
            .catch(() => {});
        },
      }),
    );
    await finished;
    await activeRun;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    abort.abort();
    approvalResolver.dispose();
    root.unmount();
    controller.dispose();
    renderer.destroy();
    await pendingSave;
  }
}
