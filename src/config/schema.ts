import { z } from "zod";
import { LspConfigSchema } from "../lsp/config.js";
import { McpConfigSchema } from "../mcp/schema.js";
import { WebConfigSchema } from "../web/schema.js";
export const ProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const ProviderProfileSchema = z.looseObject({
  providerId: z.string().min(1),
  label: z.string().optional(),
  apiKeyRef: z.string().optional(),
  baseUrl: z.url().optional(),
  defaultModel: z.string().min(1).optional(),
});
export const GlobalConfigV2Schema = z.looseObject({
  lsp: LspConfigSchema.optional(),
  schemaVersion: z.literal(2),
  defaultProfileId: ProfileIdSchema.optional(),
  profiles: z.record(ProfileIdSchema, ProviderProfileSchema),
  mcp: McpConfigSchema.optional(),
  web: WebConfigSchema.optional(),
  permissions: z
    .looseObject({ allowBypassPermissions: z.boolean().optional() })
    .optional(),
  ui: z
    .looseObject({
      sidebarMode: z.enum(["auto", "show", "hide"]).optional(),
      theme: z.enum(["obsidian", "graphite", "ember", "paper"]).optional(),
      unicodeDecorations: z.boolean().optional(),
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .optional(),
});
export const LegacyConfigSchema = z.looseObject({
  schemaVersion: z.literal(1).optional(),
  defaultProvider: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  providers: z
    .record(
      z.string(),
      z.looseObject({
        provider: z.string().optional(),
        apiKeyRef: z.string().optional(),
        baseUrl: z.url().optional(),
        defaultModel: z.string().min(1).optional(),
      }),
    )
    .default({}),
});
export type ConfigV2 = z.infer<typeof GlobalConfigV2Schema>;
