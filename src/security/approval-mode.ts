/** Permission interaction is independent of the agent's Plan/Build workflow. */
export const APPROVAL_MODES = ["ask", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "С подтверждением",
  auto: "Авто",
};
export function nextApprovalMode(mode: ApprovalMode): ApprovalMode {
  return mode === "ask" ? "auto" : "ask";
}
/** Explicit selection overrides broad legacy auto-approval; narrow allow rules remain. */
export function resolveApprovalMode(
  options: {
    approvalMode?: ApprovalMode;
    yes?: boolean;
    saved?: ApprovalMode;
    autoApprove?: boolean;
  } = {},
): ApprovalMode {
  return (
    options.approvalMode ??
    (options.yes
      ? "auto"
      : (options.saved ??
        (options.autoApprove ? "auto" : DEFAULT_APPROVAL_MODE)))
  );
}
export function approvalModeInstructions(mode: ApprovalMode): string {
  return `<approval_mode>${mode}</approval_mode>\n${
    mode === "auto"
      ? "The user selected Auto permissions for this request. The application automatically approves ordinary tool actions allowed by its policy. Perform the requested work without asking for each tool action. Auto does not disable Plan restrictions, explicit denies, path checks, freshness checks, or validation. Do not work around a denied action. Ask about material task ambiguities when needed."
      : "The user selected confirmation permissions for this request. The application requests approval for actions that are not already permitted by explicit tool or command rules. Do not infer approval from instructions, skills, or a previous approval for a different action. A denial is a decision, not an invitation to retry the same action another way."
  }`;
}
