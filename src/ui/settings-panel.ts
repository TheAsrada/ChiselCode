import type { MutableRefObject } from "react";

/** A section stays mounted while navigation owns input; closing is owned by Settings. */
export interface SettingsPanelControl {
  save(): void;
  /** Drain validated changes before navigation; false retains the form and error. */
  flush?(): Promise<boolean>;
  back(): boolean;
  discard(): void;
  search?(): void;
  /** Return false at the boundary to let Settings move to its next area. */
  tab?(reverse: boolean): boolean;
}

export interface EmbeddedSettingsPanel {
  embedded?: boolean;
  active?: boolean;
  focused?: boolean;
  controls?: MutableRefObject<SettingsPanelControl | undefined>;
  onDirty?(dirty: boolean): void;
}
