import { dlopen, ptr } from "bun:ffi";
import { join } from "node:path";
import { RuntimeError } from "../runtime/errors.js";

/** A Windows Job Object keeps descendants owned even when the Node parent crashes. */
export function ownWindowsProcessTree(pid: number): { dispose(): void } {
  const library = dlopen(
    join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "kernel32.dll",
    ),
    {
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
      SetInformationJobObject: {
        args: ["u64", "u32", "ptr", "u32"],
        returns: "u32",
      },
      OpenProcess: { args: ["u32", "u32", "u32"], returns: "u64" },
      AssignProcessToJobObject: { args: ["u64", "u64"], returns: "u32" },
      CloseHandle: { args: ["u64"], returns: "u32" },
    },
  );
  const api = library.symbols;
  const job = api.CreateJobObjectW(null, null);
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    if (job) api.CloseHandle(job);
    library.close();
  };
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on supported 64-bit Windows.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (
      !job ||
      !api.SetInformationJobObject(job, 9, ptr(limits), limits.length)
    )
      throw new Error();
    const processHandle = api.OpenProcess(0x0101, 0, pid); // SET_QUOTA | TERMINATE
    if (!processHandle) throw new Error();
    try {
      if (!api.AssignProcessToJobObject(job, processHandle)) throw new Error();
    } finally {
      api.CloseHandle(processHandle);
    }
    return { dispose };
  } catch {
    dispose();
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Windows could not establish language server process-tree ownership.",
    );
  }
}
