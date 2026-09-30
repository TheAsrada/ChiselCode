import type { ProviderDefinition } from "../contracts.js";
export const anthropicCompatible: ProviderDefinition = {
  id: "anthropic-compatible",
  label: "Anthropic-совместимый API",
  description: "Шлюз с Anthropic Messages API",
  driverId: "anthropic-messages",
  auth: {
    required: true,
    envVars: ["ANTHROPIC_AUTH_TOKEN"],
  },
  endpoint: {
    required: true,
    normalization: "anthropic-root",
  },
  defaults: {},
  capabilities: {
    modelListing: true,
    tokenCounting: "unsupported",
    usageReporting: "final",
    toolCalling: true,
    thinking: false,
  },
  driverOptions: {
    authMode: "bearer",
  },
};
