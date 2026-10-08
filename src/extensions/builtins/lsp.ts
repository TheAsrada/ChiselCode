import { z } from "zod";
import { loadGlobalConfig, loadProjectConfig } from "../../config/load.js";
import { LspServerIdSchema } from "../../lsp/config.js";
import { LspService, lspServiceToken } from "../../lsp/service.js";
import { RuntimeError } from "../../runtime/errors.js";
import { defineTool } from "../../tools/handler.js";
import type { ToolContext } from "../../tools/types.js";
import type { ChiselExtension } from "../contracts.js";

const empty = z.object({}).strict();
const file = z.object({ path: z.string().min(1).max(4096) }).strict();
const position = file.extend({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const restartInput = z
  .object({ serverId: LspServerIdSchema.optional() })
  .strict();
const readPort = (context: ToolContext) => ({
  policy: context.workspace,
  signal: context.signal,
  observe: (path: string, bytes: Buffer) =>
    context.editing.observe(path, bytes),
});
const output = (value: unknown) => ({
  output: JSON.stringify(value, null, 2),
  details: { lsp: value },
});
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Config is captured by composition, never added to the general ExtensionContext. */
export function createLspExtension(
  options: { configPath?: string } = {},
): ChiselExtension {
  return {
    id: "builtin.lsp",
    activate(ctx) {
      const service = new LspService(
        ctx.workspaceRoot,
        async () => {
          const [global, project] = await Promise.all([
            loadGlobalConfig(options.configPath),
            loadProjectConfig(ctx.workspaceRoot),
          ]);
          return {
            global: global.lsp ?? { servers: {} },
            project: project.lsp,
            ignorePatterns: project.ignorePatterns,
          };
        },
        ctx.signal,
      );
      ctx.add(service);
      ctx.services.provide(lspServiceToken, service);
      ctx.tools.register(
        defineTool(
          {
            name: "status",
            description:
              "Show Auto/custom/off TypeScript/JavaScript analysis state, backend versions and readiness. Never starts a server or scans the workspace.",
            effect: "read",
            permission: "read",
            workspaceAccess: "none",
            parallelSafe: true,
          },
          empty,
          async () => ({
            data: undefined,
            preview: "Show LSP status",
            resources: [],
          }),
          async () => output(await service.status()),
        ),
      );
      const prepare = async <T extends { path: string }>(
        context: ToolContext,
        input: T,
      ) => ({
        data: input,
        preview: `Analyse ${input.path} with workspace LSP`,
        resources: [await context.workspace.resolve(input.path)],
      });
      const readSpec = {
        effect: "read" as const,
        permission: "read",
        workspaceAccess: "read" as const,
        parallelSafe: true,
        timeoutMs: 30_000,
        outputPolicy: { maxInlineTokens: 1600 },
      };
      ctx.tools.register(
        defineTool(
          {
            ...readSpec,
            name: "diagnostics",
            description:
              "Check a saved .ts/.tsx/.js/.jsx file after edits. Auto starts the bundled backend lazily and detects tsconfig/jsconfig or an inferred project; custom executables require explicit trust. Includes revision and freshness; observed/unversioned results do not prove current error-free analysis. Pair with relevant tests.",
          },
          file,
          (context, input) => prepare(context, input),
          async (context, plan) =>
            output(
              await service.diagnostics(plan.data.path, readPort(context)),
            ),
        ),
      );
      ctx.tools.register(
        defineTool(
          {
            ...readSpec,
            name: "definition",
            description:
              "Navigate to symbol definitions before editing saved TypeScript/JavaScript. Auto selects the project and starts lazily without manual paths. line and character are zero-based; character counts UTF-16 code units. External/ignored locations are omitted; a location does not grant edit permission.",
          },
          position,
          (context, input) => prepare(context, input),
          async (context, plan) =>
            output(
              await service.definition(
                plan.data.path,
                plan.data,
                readPort(context),
              ),
            ),
        ),
      );
      ctx.tools.register(
        defineTool(
          {
            ...readSpec,
            name: "references",
            description:
              "Find affected callers/references before changing saved TypeScript/JavaScript. Auto starts lazily. Zero-based line and UTF-16 character; at most 200 permitted workspace locations.",
          },
          position
            .extend({ includeDeclaration: z.boolean().optional() })
            .strict(),
          (context, input) => prepare(context, input),
          async (context, plan) =>
            output(
              await service.references(
                plan.data.path,
                plan.data,
                (plan.data as { includeDeclaration?: boolean })
                  .includeDeclaration ?? true,
                readPort(context),
              ),
            ),
        ),
      );
      ctx.tools.register(
        defineTool(
          {
            ...readSpec,
            name: "symbols",
            description:
              "Read document symbols in a saved TypeScript/JavaScript file. At most 200 flattened entries with parent hierarchy. Does not modify code.",
          },
          file,
          (context, input) => prepare(context, input),
          async (context, plan) =>
            output(
              await service.documentSymbols(plan.data.path, readPort(context)),
            ),
        ),
      );
      ctx.tools.register(
        defineTool(
          {
            name: "restart",
            description:
              "Explicitly start/restart Auto or a trusted custom TypeScript/JavaScript server. Ordinary navigation starts lazily; use restart for recovery/config changes. Affects every tab. Requires normal process permission and Build mode; no arbitrary executable or arguments accepted.",
            effect: "process",
            permission: "process",
            workspaceAccess: "write",
            parallelSafe: false,
            timeoutMs: 45_000,
          },
          restartInput,
          async (_context, input) => {
            const launch = await service.launchPreview(input.serverId);
            const command = [launch.command, ...launch.args]
              .map(quoted)
              .join(" ");
            return {
              data: { serverId: launch.id, fingerprint: launch.fingerprint },
              command,
              preview: `Restart LSP ${launch.id} for ${ctx.workspaceRoot}; affects every tab in this workspace.\n${command}\nTypeScript: ${launch.typescriptPath}`,
              resources: [ctx.workspaceRoot],
            };
          },
          async (context, plan) => {
            const launch = await service.launchPreview(plan.data.serverId);
            if (launch.fingerprint !== plan.data.fingerprint)
              throw new RuntimeError(
                "LSP_UNAVAILABLE",
                "LSP launch configuration changed after prepare; request restart again.",
              );
            return output(
              await service.restart(plan.data.serverId, context.signal),
            );
          },
        ),
      );
      ctx.commands.register({
        name: "lsp-status",
        description: "Состояние анализа кода без запуска сервера",
        parse(args) {
          if (args.trim()) throw new Error("Usage: /lsp-status");
          return {};
        },
        execute(context) {
          return context.tools.execute("ext:builtin.lsp:status", {});
        },
      });
      ctx.commands.register({
        name: "lsp-restart",
        description:
          "Запустить/перезапустить анализ кода для всех вкладок проекта",
        usage: "[serverId]",
        parse(args) {
          const items = args.trim() ? args.trim().split(/\s+/u) : [];
          if (items.length > 1)
            throw new Error("Usage: /lsp-restart [serverId]");
          return restartInput.parse(items[0] ? { serverId: items[0] } : {});
        },
        execute(context, input) {
          return context.tools.execute("ext:builtin.lsp:restart", input);
        },
      });
      ctx.contextProviders.register({
        id: "diagnostics",
        async collect(snapshot) {
          const text = await service.collectContext(snapshot.signal);
          return text ? { text } : undefined;
        },
      });
    },
  };
}
