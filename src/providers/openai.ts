/** @deprecated Compatibility constructors. New code resolves a definition through its driver. */

import { normalizeOpenAiCompatibleBaseUrl } from "./base-url.js";
import { agentrouter } from "./definitions/agentrouter.js";
import { openai } from "./definitions/openai.js";
import { openaiCompatible } from "./definitions/openai-compatible.js";
import {
  type OpenAIAdapterOptions as DriverOptions,
  OpenAIProtocolAdapter,
} from "./drivers/openai-chat.js";

export {
  isTokenLimitError,
  normalizeOpenAIUsage,
} from "./drivers/openai-chat.js";
export interface OpenAIAdapterOptions extends DriverOptions {
  kind?: "openai" | "openai-compatible" | "agentrouter";
}
const definitions = {
  openai,
  "openai-compatible": openaiCompatible,
  agentrouter,
};
export class OpenAIAdapter extends OpenAIProtocolAdapter {
  constructor(options: OpenAIAdapterOptions = {}) {
    const d = definitions[options.kind ?? "openai"];
    super({ ...d.driverOptions, ...options, providerId: d.id });
  }
}
export class OpenAICompatibleAdapter extends OpenAIAdapter {
  constructor(options: Omit<OpenAIAdapterOptions, "kind">) {
    if (!options.baseUrl)
      throw new Error("OpenAI-compatible providers require baseUrl.");
    super({
      ...options,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(options.baseUrl),
      kind: "openai-compatible",
    });
  }
}
