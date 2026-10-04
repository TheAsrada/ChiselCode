import { resolve } from "node:path";
import type { Command } from "commander";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import { webResultSummary } from "../ui/web-result.js";
import { testWebAccess } from "../web/diagnostics.js";
import { createWebToolProvider } from "../web/provider.js";
import { resolveWebConfig } from "../web/schema.js";
import { WebSettingsStore } from "../web/settings.js";

export function registerWebCommands(program: Command): void {
  const root = program
    .command("web")
    .description("Публичный Web: настройка, статус и безопасная проверка");
  const output = (value: unknown, text: string) =>
    process.stdout.write(
      program.optsWithGlobals().json
        ? `${JSON.stringify(value)}\n`
        : `${text}\n`,
    );
  const store = new WebSettingsStore();
  const safe = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      output(
        { error: "WEB_CONFIGURATION_ERROR" },
        "Не удалось прочитать или сохранить Web settings. Проверьте конфигурацию и credential store.",
      );
      process.exitCode = 1;
    }
  };
  const status = () =>
    safe(async () => {
      const state = await store.load();
      const project = await loadProjectConfig(
        resolve(String(program.optsWithGlobals().cwd ?? process.cwd())),
      );
      const effective = resolveWebConfig(state.config, project.web);
      output(
        {
          enabled: effective.enabled,
          search: {
            provider: state.config.search.provider,
            configured: state.hasKey,
            permission: effective.permissions.search,
          },
          fetch: {
            permission: effective.permissions.fetch,
            requiresSearchKey: false,
          },
          safeBrowsing: true,
          localAddresses: "blocked",
          permissions: effective.permissions,
          limits: effective.limits,
        },
        `Web: ${effective.enabled ? "включён" : "отключён"}\nSearch: Brave · ${state.hasKey ? "ключ настроен" : "не настроен"} · ${effective.permissions.search}\nFetch: ${effective.permissions.fetch} · без поискового ключа\nPrivate network: заблокирован, включая Bypass\nНастройка: /settings → Web или chisel web configure --help`,
      );
    });
  root.action(status);
  root.command("status").action(status);
  root
    .command("configure")
    .description(
      "Настроить ссылки на ключ и user-owned разрешения; секрет не передаётся в argv",
    )
    .option("--key-env <name>", "переменная окружения с ключом Brave")
    .option("--key-ref <reference>", "ссылка на CredentialStore")
    .option("--search <decision>", "ask, allow или deny")
    .option("--fetch <decision>", "ask, allow или deny")
    .option(
      "--allow-domain <domains...>",
      "точные домены или wildcard *.example.com",
    )
    .option("--deny-domain <domains...>", "deny имеет приоритет")
    .option("--disable", "полностью отключить native Web")
    .option("--enable", "включить native Web")
    .action((raw) =>
      safe(async () => {
        if ((raw.keyEnv && raw.keyRef) || (raw.enable && raw.disable))
          throw new Error("Conflicting options.");
        const { config } = await store.load();
        if (raw.keyEnv) config.search.apiKey = { envRef: raw.keyEnv };
        if (raw.keyRef) config.search.apiKey = { secretRef: raw.keyRef };
        if (raw.enable || raw.disable) config.enabled = !raw.disable;
        if (raw.search) config.permissions.search = raw.search;
        if (raw.fetch) config.permissions.fetch = raw.fetch;
        if (raw.allowDomain) config.permissions.allowDomains = raw.allowDomain;
        if (raw.denyDomain) config.permissions.denyDomains = raw.denyDomain;
        const state = await store.save(config);
        output(
          { saved: true, searchConfigured: state.hasKey },
          "Web settings сохранены. API-ключ в конфигурацию не записывается.",
        );
      }),
    );
  root
    .command("test")
    .description(
      "Проверить публичный URL / поиск через обычный executor и permissions",
    )
    .option("--url <url>", "публичная страница", "https://example.com/")
    .option("--search <query>", "проверить поисковый backend")
    .action((raw) =>
      safe(async () => {
        const cwd = resolve(
          String(program.optsWithGlobals().cwd ?? process.cwd()),
        );
        const project = await loadProjectConfig(cwd);
        const { config } = await store.load();
        const provider = await createWebToolProvider(
          resolveWebConfig(config, project.web),
        );
        const abort = new AbortController();
        const cancel = () => abort.abort();
        process.on("SIGINT", cancel);
        try {
          const results = await testWebAccess(
            provider,
            cwd,
            { url: raw.url, query: raw.search },
            {
              allow: String(program.optsWithGlobals().allow ?? "")
                .split(",")
                .filter(Boolean),
              project,
              approvalMode: program.optsWithGlobals().approval,
              allowBypassPermissions:
                (await loadGlobalConfig()).permissions
                  ?.allowBypassPermissions === true,
              signal: abort.signal,
            },
          );
          const pending = results.some(({ result }) => result.requiresApproval);
          const failed = results.some(({ result }) => result.isError);
          const cancelled = results.some(
            ({ result }) => result.errorCode === "CANCELLED",
          );
          output(
            {
              status: cancelled
                ? "cancelled"
                : pending
                  ? "approval_required"
                  : failed
                    ? "failed"
                    : "completed",
              results,
            },
            results
              .map(
                ({ tool, result }) =>
                  `${tool}\n${result.requiresApproval ? `Нужно разрешение: ${result.preview}\nПовторите с --allow ${tool}, если согласны, или настройте /settings → Web.` : result.isError ? result.output : (webResultSummary(result) ?? "OK")}`,
              )
              .join("\n"),
          );
          process.exitCode = cancelled ? 130 : pending ? 2 : failed ? 1 : 0;
        } finally {
          process.off("SIGINT", cancel);
        }
      }),
    );
}
