export type SidebarMode = "auto" | "show" | "hide";
export type SidebarPlacement = "inline" | "overlay" | "fullscreen" | "hidden";

export interface SidebarLayout {
  placement: SidebarPlacement;
  feedWidth: number;
  sidebarWidth: number;
}

/** A single divider plus exactly forty columns, with >=70 for the feed. */
export function sidebarLayout(
  width: number,
  mode: SidebarMode,
  overlayDismissed = false,
): SidebarLayout {
  const columns = Math.max(1, Math.floor(width) || 1);
  const enoughSpace = columns >= 120 && columns - 41 >= 70;
  if (
    mode === "hide" ||
    (mode === "auto" && !enoughSpace) ||
    (mode === "show" && !enoughSpace && overlayDismissed)
  )
    return { placement: "hidden", feedWidth: columns, sidebarWidth: 0 };
  if (enoughSpace)
    return { placement: "inline", feedWidth: columns - 41, sidebarWidth: 40 };
  return {
    placement: columns < 80 ? "fullscreen" : "overlay",
    feedWidth: columns,
    sidebarWidth: columns < 80 ? columns : 40,
  };
}

/** Ctrl+B and bare /sidebar share this state transition. */
export function toggleSidebarMode(
  mode: SidebarMode,
  width: number,
): SidebarMode {
  if (mode === "show") return "hide";
  if (mode === "hide") return "show";
  return sidebarLayout(width, mode).placement === "inline" ? "hide" : "show";
}

export function parseSidebarMode(argument: string): SidebarMode | undefined {
  const value = argument.trim().toLowerCase();
  return value === "auto" || value === "show" || value === "hide"
    ? value
    : undefined;
}
