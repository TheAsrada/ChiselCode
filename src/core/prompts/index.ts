import { isGpt62Model } from "../../models/gpt-6.2.js";
import { GPT_6_2_SYSTEM_PROMPT } from "./gpt-6.2.js";
import { BASE_SYSTEM_PROMPT } from "./universal.js";

const profiles = [{ matches: isGpt62Model, prompt: GPT_6_2_SYSTEM_PROMPT }];

export function baseSystemPromptForModel(model?: string): string {
  if (!model) return BASE_SYSTEM_PROMPT;
  return (
    profiles.find(({ matches }) => matches(model))?.prompt ?? BASE_SYSTEM_PROMPT
  );
}
