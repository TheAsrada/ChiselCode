import { rename } from "node:fs/promises";

/** Windows readers/antivirus may briefly hold a handle without delete sharing.
 * Keep the old destination intact and retry only the same atomic replacement.
 * The caller owns the temporary file and can recheck its storage lease before each attempt.
 */
export async function replaceAtomicFile(
  source: string,
  destination: string,
  assertOwned: () => Promise<void> = async () => {},
  replace: typeof rename = rename,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const deadline = Date.now() + 2000;
  for (let attempt = 0; ; attempt++) {
    await assertOwned();
    try {
      await replace(source, destination);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        Date.now() >= deadline ||
        attempt >= 40
      )
        throw error;
      await new Promise<void>((done) =>
        setTimeout(
          done,
          Math.min(100, 10 * (attempt + 1), Math.max(1, deadline - Date.now())),
        ),
      );
    }
  }
}
