import type { ProviderDefinition } from "../contracts.js";
export const agentrouter: ProviderDefinition = {
  id: "agentrouter",
  label: "AgentRouter",
  description: "Ключ выдаётся в agentrouter.org/console/token",
  driverId: "openai-chat",
  auth: {
    required: true,
    envVars: ["AGENTROUTER_API_KEY"],
  },
  endpoint: {
    required: false,
    normalization: "openai-v1",
    defaultBaseUrl: "https://agentrouter.org/v1",
  },
  defaults: {
    model: "claude-opus-5",
  },
  capabilities: {
    modelListing: true,
    tokenCounting: "unsupported",
    usageReporting: "stream",
    toolCalling: true,
    thinking: true,
  },
  driverOptions: {
    tokenLimitFallback: true,
  },
};
