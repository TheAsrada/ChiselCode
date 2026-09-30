/** @deprecated Compatibility constructors; protocol implementation lives in drivers. */

import { normalizeAnthropicCompatibleBaseUrl } from "./base-url.js";
import { anthropic } from "./definitions/anthropic.js";
import { anthropicCompatible } from "./definitions/anthropic-compatible.js";
import {
  AnthropicProtocolAdapter,
  type AnthropicAdapterOptions as DriverOptions,
} from "./drivers/anthropic-messages.js";
export interface AnthropicAdapterOptions extends DriverOptions {
  kind?: "anthropic" | "anthropic-compatible";
}
const definitions = { anthropic, "anthropic-compatible": anthropicCompatible };
export class AnthropicAdapter extends AnthropicProtocolAdapter {
  constructor(options: AnthropicAdapterOptions = {}) {
    const d = definitions[options.kind ?? "anthropic"];
    super({ ...d.driverOptions, ...options, providerId: d.id });
  }
}
export class AnthropicCompatibleAdapter extends AnthropicAdapter {
  constructor(
    options: Omit<AnthropicAdapterOptions, "apiKey" | "kind"> & {
      authToken: string;
    },
  ) {
    if (!options.baseUrl)
      throw new Error("Anthropic-compatible providers require baseUrl.");
    super({
      ...options,
      baseUrl: normalizeAnthropicCompatibleBaseUrl(options.baseUrl),
      apiKey: null,
      kind: "anthropic-compatible",
    });
  }
}
