/** Additive SDK v1 features. A manifest may require them before any package code is imported. */
export const SDK_CAPABILITIES = Object.freeze([
  "ui.controls",
  "ui.style",
  "ui.nativeProps",
  "ui.panes",
  "ui.media",
  "agent.events",
] as const);
export type SdkCapability = (typeof SDK_CAPABILITIES)[number];
