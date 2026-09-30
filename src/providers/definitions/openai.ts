import type { ProviderDefinition } from "../contracts.js";
export const openai: ProviderDefinition = {
  id: "openai",
  label: "OpenAI",
  description: "Ключ создаётся на platform.openai.com/api-keys",
  driverId: "openai-chat",
  auth: {
    required: true,
    envVars: ["OPENAI_API_KEY"],
  },
  endpoint: {
    required: false,
    normalization: "none",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  defaults: {
    model: "gpt-5",
  },
  capabilities: {
    modelListing: true,
    tokenCounting: "unsupported",
    usageReporting: "stream",
    toolCalling: true,
    thinking: true,
  },
  driverOptions: {
    includeUsage: true,
  },
};
