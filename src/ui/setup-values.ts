import { builtinDefinitions } from "../providers/definitions/index.js";
export interface SetupValues {
  provider: string;
  profileId?: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}
/** @deprecated Definition.defaults.model is the source of truth. */
export function defaultModelFor(provider: string): string {
  return (
    builtinDefinitions.find((d) => d.id === provider)?.defaults.model ?? ""
  );
}
export function isValidApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
