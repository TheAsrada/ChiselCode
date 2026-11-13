import {
  builtinProviderExtensions,
  registerExtensionProviders,
} from "../extensions/provider-contributions.js";
import { CredentialStore } from "../security/credentials.js";
import type { ProviderAdapter } from "../types/domain.js";
import { type CredentialsReader, resolveCredential } from "./auth.js";
import { getProviderCatalog } from "./catalog.js";
import type {
  ProviderDefinition,
  ProviderDriver,
  ProviderHealthResult,
  ProviderProfile,
} from "./contracts.js";
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
  registerExtensionProviders(registry, builtinProviderExtensions);
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
  /** A core submit capture, so later catalog refresh cannot redirect this request. */
  definition?: ProviderDefinition;
  profileId?: string;
  registry?: ProviderRegistry;
  drivers?: DriverRegistry;
  /** Driver captured from the same catalog as the definition. */
  driver?: ProviderDriver;
  credentials?: CredentialsReader;
  apiKey?: string;
  baseUrl?: string;
  environment?: Record<string, string | undefined>;
}) {
  const catalog =
    input.registry || (input.definition && (input.driver || input.drivers))
      ? undefined
      : await getProviderCatalog();
  const registry =
    input.registry ??
    catalog?.registry ??
    (input.definition
      ? undefined
      : createBuiltinProviderRegistry(input.drivers));
  const definition =
    input.definition ?? registry?.get(input.profile.providerId);
  if (!definition)
    throw new ProviderError(
      "unavailable",
      `Provider "${input.profile.providerId}" is unavailable.`,
    );
  const apiKey =
    definition.auth.type === "subscription"
      ? undefined
      : await resolveCredential(
          definition,
          input.profile,
          input.credentials ?? new CredentialStore(),
          input.apiKey,
          input.environment,
        );
  if (
    definition.auth.type !== "subscription" &&
    definition.auth.required &&
    !apiKey
  )
    throw new MissingApiKeyError(definition.label);
  const baseUrl = resolveEndpoint(
    definition,
    input.baseUrl ?? input.profile.baseUrl,
  );
  const driver =
    input.driver ??
    input.drivers?.require(definition.driverId) ??
    registry?.driver(definition.driverId) ??
    createDriverRegistry().require(definition.driverId);
  return {
    profile: input.profile,
    profileId: input.profileId,
    definition,
    adapter: driver.create({
      definition,
      profile: input.profile,
      profileId: input.profileId,
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
