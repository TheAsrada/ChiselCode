import { stdout } from "node:process";
import type { Command } from "commander";
import { safeExtensionText } from "../extensions/external/loader.js";
import { PackageManagementError } from "../extensions/packages/errors.js";

export function packageAction<T extends unknown[]>(
  program: Command,
  action: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await action(...args);
    } catch (error) {
      const options = args.find(
        (value) => value && typeof value === "object" && !("commands" in value),
      ) as { json?: boolean } | undefined;
      const reason = safeExtensionText(
        error instanceof Error ? error.message : "Операция не завершена.",
      );
      if (options?.json || program.opts().json)
        stdout.write(
          JSON.stringify({
            outcome:
              error instanceof PackageManagementError &&
              error.code === "PACKAGE_CONFLICT"
                ? "conflict"
                : "error",
            code:
              error instanceof PackageManagementError
                ? error.code
                : "INVALID_PACKAGE",
            reason,
            committed: false,
          }) + "\n",
        );
      else process.stderr.write(`ChiselCode: ${reason}\n`);
      process.exitCode = 1;
    }
  };
}
