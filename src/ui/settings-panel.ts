import type { MutableRefObject } from "react";

/** A section stays mounted while navigation owns input; closing is owned by Settings. */
export interface SettingsPanelControl {
  save(): void;
  back(): boolean;
  discard(): void;
}

export interface EmbeddedSettingsPanel {
  embedded?: boolean;
  active?: boolean;
  focused?: boolean;
  controls?: MutableRefObject<SettingsPanelControl | undefined>;
  onDirty?(dirty: boolean): void;
}
