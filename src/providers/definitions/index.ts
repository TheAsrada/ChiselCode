import type { ProviderDefinition } from "../contracts.js";
import { agentrouter } from "./agentrouter.js";
import { anthropic } from "./anthropic.js";
import { anthropicCompatible } from "./anthropic-compatible.js";
import { openai } from "./openai.js";
import { openaiCompatible } from "./openai-compatible.js";
export const builtinDefinitions: ProviderDefinition[] = [
  anthropic,
  anthropicCompatible,
  openai,
  openaiCompatible,
  agentrouter,
];
