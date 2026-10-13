import { execa } from "execa";

/** Read-only proof for a process group owned by the live backend, never a DTO PID. */
export async function ownedGroupGone(
  group: number,
  deadline: number,
): Promise<boolean> {
  const result = await execa("ps", ["-axo", "pgid=,stat="], {
    timeout: Math.max(1, Math.min(2000, deadline - Date.now())),
    maxBuffer: 2 * 1024 * 1024,
  });
  return !result.stdout.split("\n").some((line) => {
    const [id, state] = line.trim().split(/\s+/);
    return Number(id) === group && !state?.startsWith("Z");
  });
}

/** SIGKILL delivery and actual exit are separate events. Keep the fence until proof. */
export async function waitForOwnedGroupExit(
  group: number,
  deadline: number,
  inspect: typeof ownedGroupGone = ownedGroupGone,
): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      if (await inspect(group, deadline)) return true;
    } catch {
      return false;
    }
    await new Promise<void>((done) =>
      setTimeout(done, Math.min(30, Math.max(1, deadline - Date.now()))),
    );
  }
  return false;
}
