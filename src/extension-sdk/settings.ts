/** Declarative settings. Reading a manifest never executes extension code. */
export type SettingValue = boolean | string | number;
export interface SettingField {
  name: string;
  label: string;
  description?: string;
  type: "boolean" | "string" | "number" | "enum";
  default?: SettingValue;
  required?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  minLength?: number;
  maxLength?: number;
  options?: { value: string; label: string }[];
}
/** One Settings page. Its route is derived from the manifest ID. */
export interface SettingsSection {
  title: string;
  description?: string;
  keywords?: string[];
}
export interface SettingsSchema {
  section?: SettingsSection;
  fields: SettingField[];
}
