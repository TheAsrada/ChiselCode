export type ToolEffect =
  | "read"
  | "workspace_write"
  | "process"
  | "git_write"
  | "library_write"
  | "external_read"
  | "external_write"
  | "external_destructive"
  /** Compatibility for third-party legacy handlers; never read-only. */
  | "external";

export function isReadEffect(effect: string): boolean {
  return effect === "read" || effect === "external_read";
}

export function changesWorkspace(effect: string): boolean {
  return [
    "workspace_write",
    "process",
    "git_write",
    "library_write",
    "external",
  ].includes(effect);
}
