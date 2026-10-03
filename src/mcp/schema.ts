import { z } from "zod";
import { MCP_SENSITIVE_KEY } from "./sensitive.js";

export const McpServerIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const McpDecisionSchema = z.enum(["allow", "ask", "deny"]);
export const McpCategorySchema = z.enum([
  "read",
  "write",
  "destructive",
  "unknown",
]);
export const McpValueSchema = z.union([
  z.strictObject({ secretRef: z.string().min(1).max(256) }),
  z.strictObject({ envRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  z.strictObject({ literal: z.string().max(4096) }),
]);
const values = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/), McpValueSchema)
  .default({})
  .refine(
    (map) => Object.keys(map).length <= 64,
    "Too many environment/header entries.",
  )
  .superRefine((map, ctx) => {
    for (const [name, value] of Object.entries(map))
      if (MCP_SENSITIVE_KEY.test(name) && "literal" in value)
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Use secretRef or envRef for credentials.",
        });
  });
const safeUrl = z.url().superRefine((value, ctx) => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)))
    ctx.addIssue({
      code: "custom",
      message: "Use HTTPS, or HTTP on localhost.",
    });
  if (
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => MCP_SENSITIVE_KEY.test(key))
  )
    ctx.addIssue({
      code: "custom",
      message: "Credentials must use references, not URL parameters.",
    });
});
export const McpPermissionsSchema = z
  .strictObject({
    default: McpDecisionSchema.optional(),
    categories: z
      .strictObject({
        read: McpDecisionSchema.optional(),
        write: McpDecisionSchema.optional(),
        destructive: McpDecisionSchema.optional(),
        unknown: McpDecisionSchema.optional(),
      })
      .default({}),
    tools: z
      .record(z.string().min(1).max(128), McpDecisionSchema)
      .refine((map) => Object.keys(map).length <= 1000)
      .default({}),
  })
  .default({ categories: {}, tools: {} });
export const McpServerSchema = z
  .strictObject({
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        (label) => !/\p{Cc}/u.test(label),
        "Control characters are not allowed.",
      )
      .optional(),
    enabled: z.boolean().default(true),
    transport: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("stdio"),
        command: z.string().trim().min(1).max(4096),
        args: z.array(z.string().max(8192)).max(128).default([]),
        cwd: z.string().max(4096).optional(),
      }),
      z.strictObject({
        type: z.literal("http"),
        url: safeUrl,
        headers: values,
      }),
    ]),
    env: values,
    auth: z
      .strictObject({
        token: McpValueSchema.refine(
          (v) => !("literal" in v),
          "Use a credential reference.",
        ),
      })
      .optional(),
    startupTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    callTimeoutMs: z.number().int().min(100).max(600_000).default(120_000),
    permissions: McpPermissionsSchema,
    pinnedTools: z.array(z.string().min(1).max(128)).max(32).default([]),
  })
  .superRefine((server, ctx) => {
    if (server.transport.type === "stdio") {
      const { command, args } = server.transport;
      if (/\s/.test(command) && !/[\\/]/.test(command))
        ctx.addIssue({
          code: "custom",
          path: ["transport", "command"],
          message: "Executable and arguments must be separate.",
        });
      if (
        args.some(
          (arg) =>
            /^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/i.test(
              arg,
            ) ||
            /(?:api[-_]?key|token|password|secret|authorization)\s*[=:]/i.test(
              arg,
            ) ||
            /\b(?:Bearer|Basic)\s+/i.test(arg) ||
            (() => {
              try {
                const url = new URL(arg);
                return Boolean(
                  url.username ||
                    url.password ||
                    [...url.searchParams.keys()].some((key) =>
                      MCP_SENSITIVE_KEY.test(key),
                    ),
                );
              } catch {
                return false;
              }
            })(),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["transport", "args"],
          message:
            "Pass credentials through environment references, not command arguments.",
        });
      if (server.auth)
        ctx.addIssue({
          code: "custom",
          path: ["auth"],
          message:
            "Bearer authentication is for remote connections; use environment references for local servers.",
        });
    } else if (Object.keys(server.env).length) {
      ctx.addIssue({
        code: "custom",
        path: ["env"],
        message:
          "Environment variables are for local servers; use headers/auth for remote connections.",
      });
    }
  });
export const McpConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  servers: z
    .record(McpServerIdSchema, McpServerSchema)
    .refine((servers) => Object.keys(servers).length <= 64),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type McpValue = z.infer<typeof McpValueSchema>;
export type McpPermissions = z.infer<typeof McpPermissionsSchema>;
export type McpDecision = z.infer<typeof McpDecisionSchema>;
export const DEFAULT_MCP_PERMISSIONS: McpPermissions = {
  categories: {
    read: "allow",
    write: "ask",
    destructive: "ask",
    unknown: "ask",
  },
  tools: {},
};
