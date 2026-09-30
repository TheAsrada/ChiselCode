import type { ProviderDefinition } from "../contracts.js";
export const openaiCompatible: ProviderDefinition = {
  id: "openai-compatible",
  label: "OpenAI-совместимый API",
  description: "Локальный сервер или совместимый шлюз",
  driverId: "openai-chat",
  auth: {
    required: true,
    envVars: ["OPENAI_API_KEY"],
  },
  endpoint: {
    required: true,
    normalization: "openai-v1",
  },
  defaults: {},
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
