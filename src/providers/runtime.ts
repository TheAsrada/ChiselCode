import { CredentialStore } from "../security/credentials.js";
import type { ProviderAdapter } from "../types/domain.js";
import { type CredentialsReader, resolveCredential } from "./auth.js";
import type { ProviderHealthResult, ProviderProfile } from "./contracts.js";
import { builtinDefinitions } from "./definitions/index.js";
import { createDriverRegistry, type DriverRegistry } from "./drivers/index.js";
import { resolveEndpoint } from "./endpoint.js";
import { normalizeProviderError, ProviderError } from "./errors.js";
import { ProviderRegistry } from "./registry.js";
export function createBuiltinProviderRegistry(
  drivers = createDriverRegistry(),
): ProviderRegistry {
  const registry = new ProviderRegistry(drivers);
  for (const definition of builtinDefinitions) registry.register(definition);
  return registry;
}
export class MissingApiKeyError extends ProviderError {
  constructor(provider: string) {
    super(
      "authentication",
      `Нет API-ключа для ${provider}. Запустите "chisel setup".`,
    );
    this.name = "MissingApiKeyError";
  }
}
export async function resolveProviderRuntime(input: {
  profile: ProviderProfile;
  profileId?: string;
  registry?: ProviderRegistry;
  drivers?: DriverRegistry;
  credentials?: CredentialsReader;
  apiKey?: string;
  baseUrl?: string;
  environment?: Record<string, string | undefined>;
}) {
  const drivers = input.drivers ?? createDriverRegistry();
  const registry = input.registry ?? createBuiltinProviderRegistry(drivers);
  const definition = registry.get(input.profile.providerId);
  if (!definition)
    throw new ProviderError(
      "unavailable",
      `Provider "${input.profile.providerId}" is unavailable.`,
    );
  const apiKey = await resolveCredential(
    definition,
    input.profile,
    input.credentials ?? new CredentialStore(),
    input.apiKey,
    input.environment,
  );
  if (definition.auth.required && !apiKey)
    throw new MissingApiKeyError(definition.label);
  const baseUrl = resolveEndpoint(
    definition,
    input.baseUrl ?? input.profile.baseUrl,
  );
  const driver = drivers.require(definition.driverId);
  return {
    profile: input.profile,
    profileId: input.profileId,
    definition,
    adapter: driver.create({
      definition,
      profile: input.profile,
      apiKey,
      baseUrl,
    }),
  };
}
export async function checkAdapterHealth(
  adapter: ProviderAdapter,
): Promise<ProviderHealthResult> {
  try {
    if (adapter.checkConnection) return await adapter.checkConnection();
    if (adapter.listModels) {
      const models = await adapter.listModels();
      return {
        status: "healthy",
        message: `Подключение OK — моделей доступно: ${models.length}`,
      };
    }
    return {
      status: "unsupported",
      message: "Connection check unsupported; это не ошибка подключения.",
    };
  } catch (error) {
    const failure = normalizeProviderError(error);
    return {
      status: "unhealthy",
      message:
        failure.code === "authentication"
          ? `Сервер отклонил API-ключ: ${failure.message}`
          : failure.message,
    };
  }
}
