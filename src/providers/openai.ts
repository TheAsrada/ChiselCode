import { builtinDefinitions } from "./definitions/index.js";
/** @deprecated Compatibility constructors. New code resolves a definition through its driver. */

import { normalizeOpenAiCompatibleBaseUrl } from "./base-url.js";
import { openai } from "./definitions/openai.js";
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
export class OpenAIAdapter extends OpenAIProtocolAdapter {
  constructor(options: OpenAIAdapterOptions = {}) {
    const d = builtinDefinitions.find(
      (d) => d.id === (options.kind ?? openai.id),
    );
    if (d?.driverId !== "openai-chat")
      throw new Error("Unknown legacy provider definition for this protocol.");
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
