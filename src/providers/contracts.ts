import type { ProviderAdapter } from "../types/domain.js";

export type { ProviderAdapter } from "../types/domain.js";
export type ProviderId = string;
export type DriverId = string;
export type ProfileId = string;
export interface ProviderCapabilities {
  modelListing: boolean;
  tokenCounting: "native" | "unsupported";
  usageReporting: "stream" | "final" | "unknown";
  toolCalling: boolean;
  thinking: boolean;
}
export interface ProviderProfile {
  providerId: ProviderId;
  label?: string;
  apiKeyRef?: string;
  baseUrl?: string;
  defaultModel?: string;
  [key: string]: unknown;
}
export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  description?: string;
  driverId: DriverId;
  auth: {
    required: boolean;
    envVars: string[];
    type?: "api-key" | "subscription";
  };
  endpoint: {
    required: boolean;
    defaultBaseUrl?: string;
    normalization: "none" | "openai-v1" | "anthropic-root";
  };
  defaults: { model?: string };
  capabilities: ProviderCapabilities;
  driverOptions?: Record<string, unknown>;
  pricing?: Record<string, { input: number; output: number }>;
}
export type ProviderSource =
  | { type: "builtin" }
  | { type: "extension"; extensionId: string }
  | { type: "user-manifest"; directory: string; manifestPath: string };
export interface RegisteredProvider {
  definition: ProviderDefinition;
  source: ProviderSource;
}
export interface ProviderDiagnostic {
  severity: "warning" | "error";
  code:
    | "manifest_invalid"
    | "manifest_too_large"
    | "duplicate_id"
    | "reserved_id"
    | "unknown_driver"
    | "unsupported_schema"
    | "unsafe_symlink"
    | "invalid_driver_options"
    | "insecure_endpoint";
  path?: string;
  providerId?: string;
  message: string;
}
export interface ProviderDriverContext {
  definition: ProviderDefinition;
  profile: ProviderProfile;
  profileId?: string;
  apiKey?: string;
  baseUrl?: string;
}
export interface ProviderDriver {
  readonly id: DriverId;
  validateDefinition?(definition: ProviderDefinition): ProviderDiagnostic[];
  create(context: ProviderDriverContext): ProviderAdapter;
}
export interface ProviderHealthResult {
  status: "healthy" | "unhealthy" | "unsupported";
  message: string;
}

export interface CostEstimate {
  usd?: number;
  source: "provider" | "estimated" | "unknown";
}

export interface ConnectionChallenge {
  url: string;
  code: string;
  expiresAt: number;
}
export interface ConnectionStatus {
  connected: boolean;
  label?: string;
}
export interface ProviderConnection {
  status(profileId: string): Promise<ConnectionStatus>;
  connect(input: {
    profileId: string;
    signal: AbortSignal;
    challenge(value: ConnectionChallenge): void;
  }): Promise<ConnectionStatus>;
  disconnect(profileId: string): Promise<void>;
}
/** Linked application contribution, captured independently of workspace activation. */
export interface ProviderContribution {
  readonly definition: ProviderDefinition;
  create(context: ProviderDriverContext): ProviderAdapter;
  readonly connection?: ProviderConnection;
}
