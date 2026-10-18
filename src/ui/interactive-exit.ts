export type InteractiveExitReason = "exit" | "update";

/** Called only after application, extension host and terminal cleanup. */
export async function completeInteractiveExit(
  reason: InteractiveExitReason,
  pause: () => Promise<void>,
  exit: (code: number) => void = process.exit,
): Promise<void> {
  if (reason === "update") {
    // An Explorer pause or an unrelated open handle must not keep chisel.exe locked.
    exit(0);
    return;
  }
  await pause();
}
