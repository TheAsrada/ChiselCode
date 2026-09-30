import type { ProviderDefinition } from "../contracts.js";
export const anthropic: ProviderDefinition = {
  id: "anthropic",
  label: "Anthropic",
  description: "Ключ создаётся в console.anthropic.com",
  driverId: "anthropic-messages",
  auth: {
    required: true,
    envVars: ["ANTHROPIC_API_KEY"],
  },
  endpoint: {
    required: false,
    normalization: "none",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  defaults: {
    model: "claude-opus-5",
  },
  capabilities: {
    modelListing: true,
    tokenCounting: "native",
    usageReporting: "final",
    toolCalling: true,
    thinking: true,
  },
  driverOptions: {
    authMode: "api-key",
    adaptiveThinking: true,
    nativeTokenCounting: true,
  },
};
