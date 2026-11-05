import type { ProviderRegistry } from "../providers/registry.js";
import { chatGptExtension } from "./builtins/chatgpt/index.js";
import type { ChiselExtension } from "./contracts.js";

export const builtinProviderExtensions: readonly ChiselExtension[] = [
  chatGptExtension,
];
export function registerExtensionProviders(
  registry: ProviderRegistry,
  extensions: readonly ChiselExtension[],
) {
  for (const extension of extensions)
    for (const contribution of extension.providers ?? [])
      registry.registerContribution(contribution, extension.id);
}
