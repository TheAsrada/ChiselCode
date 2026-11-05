import { z } from "zod";
import type {
  ProviderContribution,
  ProviderDefinition,
  ProviderDriver,
  ProviderSource,
  RegisteredProvider,
} from "./contracts.js";
import { createDriverRegistry, type DriverRegistry } from "./drivers/index.js";
import { ProviderError } from "./errors.js";
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
    type: z.enum(["api-key", "subscription"]).optional(),
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
const contributedDrivers = new WeakMap<ProviderDriver, ProviderContribution>();
export class ProviderRegistry {
  private connections = new Map<string, ProviderContribution["connection"]>();
  driver(id: string) {
    return this.drivers.require(id);
  }
  connection(id: string) {
    return this.connections.get(id);
  }
  registerContribution(
    contribution: ProviderContribution,
    extensionId: string,
  ): void {
    const definition = providerDefinitionSchema.parse(contribution.definition);
    const id = definition.id;
    if (this.has(id)) throw new Error(`Duplicate provider ID "${id}".`);
    if (definition.auth.type === "subscription" && !contribution.connection)
      throw new Error("Subscription providers require a connection port.");
    const existing = this.drivers.get(definition.driverId);
    if (existing && contributedDrivers.get(existing) !== contribution)
      throw new Error(
        `Extension driver "${definition.driverId}" is already registered.`,
      );
    if (!existing) {
      const driver: ProviderDriver = {
        id: definition.driverId,
        create: (context) => contribution.create(context),
        validateDefinition: (candidate) =>
          candidate.id === id
            ? []
            : [
                {
                  severity: "error",
                  code: "invalid_driver_options",
                  message: "Драйвер расширения принадлежит другому провайдеру.",
                },
              ],
      };
      this.drivers.register(driver);
      contributedDrivers.set(driver, contribution);
    }
    this.register(definition, { type: "extension", extensionId });
    this.connections.set(id, contribution.connection);
  }
  private entries = new Map<string, RegisteredProvider>();
  constructor(private drivers: DriverRegistry = createDriverRegistry()) {}
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
    if (!value)
      throw new ProviderError(
        "unavailable",
        `Provider "${id}" is unavailable.`,
      );
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
