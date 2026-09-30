/** @deprecated Definition + openai-chat driver replace this compatibility constructor. */

import { normalizeOpenAiCompatibleBaseUrl } from "./base-url.js";
import { agentrouter } from "./definitions/agentrouter.js";
import { builtinDefinitions } from "./definitions/index.js";
import { OpenAIAdapter } from "./openai.js";
export const AGENTROUTER_BASE_URL = agentrouter.endpoint
  .defaultBaseUrl as string;
export const AGENTROUTER_DEFAULT_MODEL = agentrouter.defaults.model as string;
export const AGENTROUTER_API_KEY_ENV = agentrouter.auth.envVars[0] as string;
export function defaultBaseUrlForProvider(
  provider: string,
): string | undefined {
  const definition = builtinDefinitions.find((d) => d.id === provider);
  return definition?.endpoint.normalization !== "none"
    ? definition?.endpoint.defaultBaseUrl
    : undefined;
}
export class AgentRouterAdapter extends OpenAIAdapter {
  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    super({
      ...options,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(
        options.baseUrl?.trim() || AGENTROUTER_BASE_URL,
      ),
      kind: agentrouter.id as "agentrouter",
    });
  }
}
