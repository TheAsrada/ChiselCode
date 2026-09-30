import type { ProviderDefinition, ProviderProfile } from "./contracts.js";
export interface CredentialsReader {
  get(ref: string): Promise<string | undefined>;
}
export async function resolveCredential(
  definition: ProviderDefinition,
  profile: ProviderProfile,
  credentials: CredentialsReader,
  transientKey?: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (transientKey?.trim()) return transientKey.trim();
  for (const name of definition.auth.envVars) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return profile.apiKeyRef ? credentials.get(profile.apiKeyRef) : undefined;
}
