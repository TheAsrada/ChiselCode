import { z } from "zod";
import { readBrowserPolicy, requireOrigin } from "../../browser/config.js";
import { safeText } from "../../browser/page.js";
import { type BrowserAction, BrowserService } from "../../browser/service.js";
import { registerBrowserUi } from "../../browser/ui.js";
import { RuntimeError } from "../../runtime/errors.js";
import { defineTool } from "../../tools/handler.js";
import type {
  ConversationToolOwner,
  ToolContext,
  ToolSpec,
} from "../../tools/types.js";
import type { ChiselExtension } from "../contracts.js";

export const browserId = "builtin.browser";
const ns = `ext:${browserId}:`;
const empty = z.object({}).strict();
const tab = z.object({
  tab: z
    .uuid()
    .optional()
    .describe("Tab ID from status; defaults to the selected tab."),
});
const selector = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.includes(">>"))
  .describe("CSS selector identifying exactly one element.");
const element = {
  ref: z
    .uuid()
    .optional()
    .describe("Opaque reference from the latest snapshot."),
  selector: selector.optional(),
};
const oneElement = (value: { ref?: string; selector?: string }) =>
  Boolean(value.ref) !== Boolean(value.selector);
const navigation = z.union([
  tab
    .extend({
      action: z.enum(["back", "reload", "close", "select", "refresh"]),
    })
    .strict(),
  tab
    .extend({
      action: z.literal("viewport"),
      preset: z.enum(["phone", "tablet", "desktop"]),
    })
    .strict(),
  tab
    .extend({
      action: z.literal("viewport"),
      width: z.number().int().min(320).max(1600),
      height: z.number().int().min(240).max(1200),
    })
    .strict(),
]);
const interaction = tab
  .extend({
    ...element,
    operation: z.enum(["click", "fill", "select", "press", "scroll"]),
    value: z
      .string()
      .max(500)
      .optional()
      .describe("Fill text, option value, or a supported keyboard key."),
  })
  .strict()
  .refine(oneElement, "Specify exactly one ref or selector.")
  .refine(({ operation, value }) => {
    if (operation === "press")
      return Boolean(
        value &&
          /^(?:Enter|Tab|Shift\+Tab|Escape|Space|Arrow(?:Up|Down|Left|Right)|Backspace|Delete|Home|End|[a-zA-Z0-9])$/.test(
            value,
          ),
      );
    return operation === "fill" || operation === "select"
      ? value !== undefined
      : value === undefined;
  }, "Specify a value only for fill, select or press. Press accepts Enter, Tab, Shift+Tab, Escape, Space, arrows, Backspace, Delete, Home, End or one alphanumeric key.");

function identity(context: ToolContext): ConversationToolOwner {
  if (!context.conversationOwner)
    throw new RuntimeError(
      "BROWSER_UNAVAILABLE",
      "Browser needs a live conversation owner.",
    );
  return context.conversationOwner;
}

const omitPreview = <T extends { preview?: string }>(value: T) => {
  const { preview: _preview, ...text } = value;
  return text;
};

const browserPresentation = z.object({
  closed: z.string().optional(),
  state: z.literal("ready").optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  viewport: z
    .object({ width: z.number(), height: z.number() })
    .nullable()
    .optional(),
  snapshot: z.object({ overflow: z.number() }).optional(),
  screenshot: z
    .object({ uri: z.string(), width: z.number(), height: z.number() })
    .optional(),
});
function browserSummary(value: unknown) {
  const parsed = browserPresentation.safeParse(value);
  if (!parsed.success) return;
  const data = parsed.data;
  if (data.screenshot) {
    const { uri, width, height } = data.screenshot;
    return `Снимок · ${width} × ${height}
${uri}`;
  }
  if (data.closed) return "Вкладка Chromium закрыта.";
  if (data.state === "ready") return "Chromium установлен.";
  if (!data.url) return;
  return [
    [data.title, data.url].filter(Boolean).join(" · "),
    data.viewport
      ? `${data.viewport.width} × ${data.viewport.height}`
      : undefined,
    data.snapshot
      ? `Горизонтальное переполнение: ${data.snapshot.overflow} px`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1600);
}

export function createBrowserExtension(
  options: { configPath?: string } = {},
): ChiselExtension {
  return {
    id: browserId,
    async activate(ctx) {
      const policy = () =>
        readBrowserPolicy(ctx.workspaceRoot, options.configPath);
      if (!(await policy()).enabled) return;
      const service = new BrowserService(ctx.workspaceRoot, options.configPath);
      ctx.add(service);
      ctx.chat.register({
        id: "operation",
        render(value) {
          const output = (value as { output?: string })?.output;
          const summary = output
            ? browserSummary(JSON.parse(output))
            : undefined;
          return summary ? { summary } : undefined;
        },
      });

      const register = <Input, Prepared>(
        name: string,
        description: string,
        effect: ToolSpec["effect"],
        input: z.ZodType<Input>,
        prepare: (
          context: ToolContext,
          input: Input,
        ) => Promise<{ data: Prepared; preview: string }>,
        execute: (context: ToolContext, prepared: Prepared) => Promise<unknown>,
        timeoutMs = 25_000,
      ) =>
        ctx.tools.register(
          defineTool(
            {
              name,
              description,
              ...(effect !== "read"
                ? { chat: { title: "Браузер", view: "operation" } }
                : {}),
              effect,
              workspaceAccess: "none",
              permission: effect === "read" ? "read" : "browser",
              parallelSafe: effect === "read",
              timeoutMs,
              outputPolicy: { maxInlineTokens: 2500 },
            },
            input,
            async (context, input) => {
              requireOrigin(await policy());
              return { ...(await prepare(context, input)), resources: [] };
            },
            async (context, plan) => {
              requireOrigin(await policy());
              return {
                output: JSON.stringify(await execute(context, plan.data)),
              };
            },
          ),
        );

      const passive = <Input>(
        name: string,
        description: string,
        schema: z.ZodType<Input>,
        read: (id: string, input: Input) => Promise<unknown>,
      ) =>
        register(
          name,
          description,
          "read",
          schema,
          async (_context, data) => ({
            data,
            preview: "Read cached browser information",
          }),
          (context, input) => read(identity(context).id, input),
        );

      const active = <Input extends BrowserAction>(
        name: "open" | "navigate" | "interact" | "inspect" | "screenshot",
        description: string,
        schema: z.ZodType<Input>,
      ) =>
        register(
          name,
          description,
          name === "open" ? "process" : "external_write",
          schema,
          async (context, input) => {
            const data = await service.prepare(identity(context).id, input);
            return {
              data,
              preview: `Browser ${input.operation ?? input.action ?? name} · ${safeText(data.url ?? data.origin ?? "")}${data.tab ? ` · tab ${data.tab}` : ""}`,
            };
          },
          (context, input) =>
            service.run(
              identity(context),
              input,
              name,
              context.signal,
              input.modelImage
                ? (origin, bytes) =>
                    context.offerToolImage?.(origin, {
                      mimeType: "image/png",
                      bytes,
                    }) ?? Promise.resolve(false)
                : undefined,
            ),
        );

      passive(
        "status",
        "List owned tabs, selected tab, URL, title, viewport and the last accessibility snapshot, overflow and refs. Reads cached observations without launching Chromium. Browser resources are live only during this conversation.",
        tab.strict(),
        async (id, input) => omitPreview(await service.view(id, input.tab)),
      );
      passive(
        "diagnostics",
        "Read a bounded console or network log for one tab. Filter by exact type (pageerror, error, failed, response, websocket, or a console level); use cursor as the next after value.",
        tab
          .extend({
            kind: z.enum(["console", "network"]),
            after: z.number().int().nonnegative().optional(),
            type: z.string().max(24).optional(),
          })
          .strict(),
        (id, input) =>
          service.diagnostics(
            id,
            input.kind,
            input.tab,
            input.after,
            input.type,
          ),
      );
      active(
        "open",
        "Open a new headless Chromium tab at a user-granted HTTP loopback origin with explicit port. Starts Chromium lazily, runs page JS and returns URL, title, viewport and accessibility. For QA, collect observations at each viewport, edit the workspace with standard tools, reload, and repeat the same scenario.",
        z.object({ url: z.string().trim().max(2048) }).strict(),
      );
      // Separate schemas give providers a top-level object for every function tool.
      active(
        "navigate",
        "Go back, reload, select or close a tab, capture a fresh accessibility snapshot (refresh), or change viewport. Viewport accepts phone 390×844, tablet 768×1024, desktop 1280×800 or explicit width and height.",
        tab
          .extend({
            action: z.enum([
              "back",
              "reload",
              "close",
              "select",
              "refresh",
              "viewport",
            ]),
            preset: z.enum(["phone", "tablet", "desktop"]).optional(),
            width: z.number().int().min(320).max(1600).optional(),
            height: z.number().int().min(240).max(1200).optional(),
          })
          .strict()
          .refine(
            (input) => navigation.safeParse(input).success,
            "Specify a preset or width and height only for viewport.",
          ),
      );
      active(
        "interact",
        "Perform a single click, fill, select, press or scroll-to-element action on the approved dev origin. Use a current ref or unique CSS selector. Returns a fresh snapshot. Never automatically retries page actions.",
        interaction,
      );
      active(
        "inspect",
        "Read fixed DOM fields, computed styles, element bounds and viewport intersection from the live tab. Provide a current ref or unique CSS selector. No arbitrary JavaScript.",
        tab.extend(element).strict().refine(oneElement),
      );
      active(
        "screenshot",
        "Capture a private, masked PNG of the viewport or a single element. Optionally identify extra sensitive areas with mask CSS. Returns a local URI, pixel dimensions and text summary; history receives text.",
        tab
          .extend({
            ...element,
            mask: selector.optional(),
            fullPage: z
              .boolean()
              .optional()
              .describe(
                "Capture the whole document up to 1600×1200; omit ref and selector.",
              ),
            modelImage: z
              .boolean()
              .optional()
              .describe(
                "Request model delivery if the active subscription profile permits images.",
              ),
          })
          .strict()
          .refine(
            (input) =>
              !(input.ref && input.selector) &&
              !(input.fullPage && (input.ref || input.selector)),
          ),
      );
      register(
        "install",
        "Install pinned Playwright and Chromium into the private application cache on Linux x64. Explicit download; does not open a page.",
        "process",
        empty,
        async () => ({
          data: undefined,
          preview:
            "Install pinned Playwright and Chromium from registry.npmjs.org and storage.googleapis.com into the browser cache",
        }),
        (context) => service.install(context.signal),
        180_000,
      );
      register(
        "panel",
        "Toggle the browser pane for the current conversation. Does not contact the model or start Chromium.",
        "read",
        empty,
        async () => ({ data: undefined, preview: "Toggle browser pane" }),
        async (context) => ({
          visible: await service.toggle(identity(context)),
        }),
      );

      ctx.commands.register({
        name: "browser",
        description: "панель браузера для проверки локального приложения",
        usage: "/browser [install|open <URL>]",
        executionPolicy: "foreground",
        parse(args) {
          const input = args.trim();
          if (input === "install") return { tool: "install", input: {} };
          if (input.startsWith("open "))
            return { tool: "open", input: { url: input.slice(5).trim() } };
          if (input)
            throw new Error("Использование: /browser [install|open <URL>]");
          return { tool: "panel", input: {} };
        },
        async execute(invocation, parsed) {
          const result = await invocation.tools.execute(
            ns + parsed.tool,
            parsed.tool === "open" ? { url: String(parsed.input.url) } : {},
          );
          return parsed.tool === "panel" && !result.isError
            ? {
                output: JSON.parse(result.output).visible
                  ? "Панель «Браузер» открыта."
                  : "Панель «Браузер» закрыта.",
              }
            : result;
        },
      });
      registerBrowserUi(ctx, service);
    },
  };
}
