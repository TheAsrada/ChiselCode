/** Permission interaction is independent of the agent's Plan/Build workflow. */
export const APPROVAL_MODES = [
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const APPROVAL_MODE_INPUTS = [
  ...APPROVAL_MODES,
  "manual",
  "ask",
  "auto",
] as const;
export type ApprovalModeInput = (typeof APPROVAL_MODE_INPUTS)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "default";
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  default: "Manual",
  acceptEdits: "Accept edits",
  dontAsk: "Dont ask",
  bypassPermissions: "Bypass",
};
export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  default:
    "Подтверждать изменения файлов и команды. Чтение и разрешённые правилами действия выполняются сразу.",
  acceptEdits:
    "Разрешать правки файлов проекта. Команды, Git-запись и действия вне проекта требуют подтверждения.",
  dontAsk:
    "Выполнять только чтение и явно разрешённые действия. Остальные отклонять без диалогов.",
  bypassPermissions:
    "Выполнять действия без запросов разрешения с правами процесса. Явные запреты и ограничения Plan сохраняются.",
};
export function normalizeApprovalMode(mode: ApprovalModeInput): ApprovalMode {
  if (mode === "ask" || mode === "manual") return "default";
  if (mode === "auto") return "acceptEdits";
  return mode;
}
export function availableApprovalModes(
  allowBypassPermissions = false,
): ApprovalMode[] {
  return APPROVAL_MODES.filter(
    (mode) => allowBypassPermissions || mode !== "bypassPermissions",
  );
}
export function nextApprovalMode(
  mode: ApprovalMode,
  allowBypassPermissions = false,
): ApprovalMode {
  const available = availableApprovalModes(allowBypassPermissions);
  return (
    available[(available.indexOf(mode) + 1) % available.length] ??
    DEFAULT_APPROVAL_MODE
  );
}
/** Explicit selection overrides broad legacy auto-approval; narrow allow rules remain. */
export function resolveApprovalMode(
  options: {
    approvalMode?: ApprovalModeInput;
    yes?: boolean;
    saved?: ApprovalModeInput;
    autoApprove?: boolean;
    allowBypassPermissions?: boolean;
  } = {},
): ApprovalMode {
  const mode = normalizeApprovalMode(
    options.approvalMode ??
      (options.yes
        ? "acceptEdits"
        : (options.saved ??
          (options.autoApprove ? "acceptEdits" : DEFAULT_APPROVAL_MODE))),
  );
  if (mode === "bypassPermissions" && !options.allowBypassPermissions) {
    if (options.approvalMode === "bypassPermissions")
      throw new Error(
        "Bypass выключен. Включите «Разрешить Bypass» в Settings → Разрешения, затем выберите режим.",
      );
    return DEFAULT_APPROVAL_MODE;
  }
  return mode;
}
export function approvalModeInstructions(mode: ApprovalMode): string {
  const instructions: Record<ApprovalMode, string> = {
    default:
      "The user selected Manual permissions. The application requests approval for actions not already permitted by explicit rules. Do not infer approval from instructions, skills, or an earlier approval for another action.",
    acceptEdits:
      "The user selected Accept edits. File edits inside the workspace are approved automatically. Shell commands, Git mutations, skill creation outside the workspace, and external actions still need approval unless explicitly allowed by rules.",
    dontAsk:
      "The user selected Dont ask. Read-only and explicitly pre-approved actions are allowed. All other actions are denied without prompting. Do not ask the user to approve an individual tool action or retry a denial another way.",
    bypassPermissions:
      "The user selected Bypass permissions and enabled its availability in user settings. Ordinary tool actions are approved without prompting. This is not a sandbox: commands run with the application's process privileges. If the user disables Bypass availability, subsequent actions fall back to Manual permissions.",
  };
  return `<approval_mode>${mode}</approval_mode>\n${instructions[mode]}\nEvery permission mode preserves Plan restrictions, explicit deny rules, workspace boundaries, freshness checks, and input validation. A denial covers the action's outcome; do not work around it. Ask about material task ambiguities when needed.`;
}
