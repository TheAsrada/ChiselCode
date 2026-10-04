import { z } from "zod";

export const DomainPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
export const WebPermissionSchema = z.enum(["ask", "allow", "deny"]);
export const WebPermissionsSchema = z
  .strictObject({
    search: WebPermissionSchema.default("ask"),
    fetch: WebPermissionSchema.default("ask"),
    allowDomains: z
      .array(DomainPatternSchema)
      .max(256)
      .default(() => []),
    denyDomains: z
      .array(DomainPatternSchema)
      .max(256)
      .default(() => []),
  })
  .default(() => ({
    search: "ask" as const,
    fetch: "ask" as const,
    allowDomains: [],
    denyDomains: [],
  }));
export const WebCredentialSchema = z.union([
  z.strictObject({ secretRef: z.string().min(1).max(256) }),
  z.strictObject({
    envRef: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(128),
  }),
]);
export const WebLimitsSchema = z
  .strictObject({
    connectTimeoutMs: z.number().int().min(100).max(30000).default(8000),
    requestTimeoutMs: z.number().int().min(100).max(60000).default(30000),
    maxRedirects: z.number().int().min(0).max(10).default(5),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(8 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    maxDecompressedBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    maxExtractedChars: z.number().int().min(1000).max(200000).default(100000),
    maxConcurrent: z.number().int().min(1).max(8).default(3),
    maxRequestsPerTurn: z.number().int().min(1).max(100).default(24),
  })
  .default(() => ({
    connectTimeoutMs: 8000,
    requestTimeoutMs: 30000,
    maxRedirects: 5,
    maxResponseBytes: 2 * 1024 * 1024,
    maxDecompressedBytes: 4 * 1024 * 1024,
    maxExtractedChars: 100000,
    maxConcurrent: 3,
    maxRequestsPerTurn: 24,
  }));
export const WebConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    enabled: z.boolean().default(true),
    search: z
      .strictObject({
        provider: z.literal("brave").default("brave"),
        apiKey: WebCredentialSchema.default(() => ({
          envRef: "BRAVE_SEARCH_API_KEY",
        })),
      })
      .default(() => ({
        provider: "brave" as const,
        apiKey: { envRef: "BRAVE_SEARCH_API_KEY" },
      })),
    permissions: WebPermissionsSchema,
    limits: WebLimitsSchema,
    cacheTtlMs: z.number().int().min(0).max(3600000).default(300000),
  })
  .default(() => ({
    schemaVersion: 1 as const,
    enabled: true,
    search: {
      provider: "brave" as const,
      apiKey: { envRef: "BRAVE_SEARCH_API_KEY" },
    },
    permissions: {
      search: "ask" as const,
      fetch: "ask" as const,
      allowDomains: [],
      denyDomains: [],
    },
    limits: {
      connectTimeoutMs: 8000,
      requestTimeoutMs: 30000,
      maxRedirects: 5,
      maxResponseBytes: 2 * 1024 * 1024,
      maxDecompressedBytes: 4 * 1024 * 1024,
      maxExtractedChars: 100000,
      maxConcurrent: 3,
      maxRequestsPerTurn: 24,
    },
    cacheTtlMs: 300000,
  }));

/** Repository configuration can restrict access, never grant user permissions. */
export const ProjectWebConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  denyDomains: z
    .array(DomainPatternSchema)
    .max(256)
    .default(() => []),
  maxRequestsPerTurn: z.number().int().min(1).max(100).optional(),
});
export const SearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  domains: z
    .array(DomainPatternSchema.refine((s) => !s.startsWith("*.")))
    .max(10)
    .default(() => []),
  excludeDomains: z
    .array(DomainPatternSchema.refine((s) => !s.startsWith("*.")))
    .max(10)
    .default(() => []),
  limit: z.number().int().min(1).max(10).default(5),
});
export const FetchInputSchema = z.strictObject({
  url: z.string().min(1).max(4096),
  maxChars: z.number().int().min(1000).max(200000).default(30000),
});
export type WebConfig = z.output<typeof WebConfigSchema>;
export type WebLimits = WebConfig["limits"];
export type WebPermissions = WebConfig["permissions"];
export type ProjectWebConfig = z.output<typeof ProjectWebConfigSchema>;
export type SearchInput = z.output<typeof SearchInputSchema>;
export type FetchInput = z.output<typeof FetchInputSchema>;

export function resolveWebConfig(
  global?: unknown,
  project?: ProjectWebConfig,
): WebConfig {
  const value = WebConfigSchema.parse(global);
  return {
    ...value,
    enabled: value.enabled && project?.enabled !== false,
    permissions: {
      ...value.permissions,
      denyDomains: [
        ...new Set([
          ...value.permissions.denyDomains,
          ...(project?.denyDomains ?? []),
        ]),
      ],
    },
    limits: {
      ...value.limits,
      maxRequestsPerTurn: Math.min(
        value.limits.maxRequestsPerTurn,
        project?.maxRequestsPerTurn ?? Infinity,
      ),
    },
  };
}
