import { z } from "zod";
import type {
  ProviderDefinition,
  ProviderSource,
  RegisteredProvider,
} from "./contracts.js";
import type { DriverRegistry } from "./drivers/index.js";
export const envVarNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
export const customProviderIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
export const providerCapabilitiesSchema = z.object({
  modelListing: z.boolean(),
  tokenCounting: z.enum(["native", "unsupported"]),
  usageReporting: z.enum(["stream", "final", "unknown"]),
  toolCalling: z.boolean(),
  thinking: z.boolean(),
});
export const endpointSchema = z.object({
  required: z.boolean(),
  defaultBaseUrl: z
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    })
    .optional(),
  normalization: z.enum(["none", "openai-v1", "anthropic-root"]),
});
export const providerDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  driverId: z.string().min(1),
  auth: z.object({
    required: z.boolean(),
    envVars: z.array(envVarNameSchema).max(10),
  }),
  endpoint: endpointSchema,
  defaults: z.object({ model: z.string().trim().min(1).optional() }),
  capabilities: providerCapabilitiesSchema,
  driverOptions: z.record(z.string(), z.unknown()).optional(),
  pricing: z
    .record(
      z.string(),
      z.object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
      }),
    )
    .optional(),
});
export class ProviderRegistry {
  private entries = new Map<string, RegisteredProvider>();
  constructor(private drivers?: DriverRegistry) {}
  register(
    definition: ProviderDefinition,
    source: ProviderSource = { type: "builtin" },
  ): void {
    const parsed = providerDefinitionSchema.parse(definition);
    if (source.type === "user-manifest")
      customProviderIdSchema.parse(parsed.id);
    if (this.has(parsed.id))
      throw new Error(`Duplicate provider ID "${parsed.id}".`);
    if (this.drivers) {
      const driver = this.drivers.require(parsed.driverId);
      const errors = driver
        .validateDefinition?.(parsed)
        ?.filter((d) => d.severity === "error");
      if (errors?.length)
        throw new Error(errors.map((d) => d.message).join("; "));
    }
    this.entries.set(parsed.id, {
      definition: structuredClone(parsed),
      source: { ...source },
    });
  }
  get(id: string): ProviderDefinition | undefined {
    return this.entries.get(id)?.definition;
  }
  require(id: string): ProviderDefinition {
    const value = this.get(id);
    if (!value) throw new Error(`Provider "${id}" is unavailable.`);
    return value;
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  list(): ProviderDefinition[] {
    return [...this.entries.values()]
      .map((e) => e.definition)
      .sort((a, b) => a.id.localeCompare(b.id, "en"));
  }
  source(id: string): ProviderSource | undefined {
    return this.entries.get(id)?.source;
  }
  search(query: string): ProviderDefinition[] {
    const q = query.toLowerCase();
    return this.list().filter((d) =>
      `${d.id} ${d.label} ${d.description ?? ""}`.toLowerCase().includes(q),
    );
  }
}
