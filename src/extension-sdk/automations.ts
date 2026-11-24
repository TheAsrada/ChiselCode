import type { JsonObject } from "./index.js";

export type AutomationSchedule =
  | { readonly kind: "once"; readonly at: string }
  | {
      readonly kind: "interval";
      readonly firstAt: string;
      readonly everyMs: number;
    };

export interface AutomationDefinition {
  /** Keep this ID stable across versions. Use a new ID for a different schedule. */
  readonly id: string;
  readonly schedule: AutomationSchedule;
  /** A native tool or a tool owned by this extension. Uses normal permissions. */
  readonly tool: { readonly name: string; readonly input: JsonObject };
}

export interface AutomationRegistrations {
  register(definition: AutomationDefinition): void;
}
