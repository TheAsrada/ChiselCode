import { opendir, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { cancelled } from "../runtime/errors.js";
import type { WorkspacePolicy } from "../security/workspace-policy.js";
import type { LspServerDescriptor } from "./catalog.js";

/** Nearest permitted project marker; bounded ancestors, never recursive discovery. */
export async function lspProjectRoot(
  policy: WorkspacePolicy,
  file: string,
  descriptor?: LspServerDescriptor,
  signal?: AbortSignal,
): Promise<string> {
  if (!descriptor?.rootMarkers.length || descriptor.id === "auto")
    return policy.root;
  let directory = dirname(await policy.resolve(file));
  for (let depth = 0; depth < 64; ++depth) {
    cancelled(signal);
    for (const marker of descriptor.rootMarkers) {
      try {
        if (marker.startsWith("*.")) {
          const entries = await opendir(directory);
          let inspected = 0;
          for await (const item of entries) {
            cancelled(signal);
            if (++inspected > 256) break;
            if (!item.isFile() || !item.name.endsWith(marker.slice(1)))
              continue;
            try {
              await policy.resolve(
                `${relative(policy.root, directory) || "."}/${item.name}`,
              );
              return directory;
            } catch {
              cancelled(signal);
            }
          }
          continue;
        }
        const path = await policy.resolve(
          `${relative(policy.root, directory) || "."}/${marker}`,
        );
        if ((await stat(path)).isFile()) return directory;
      } catch {
        cancelled(
          signal,
        ); /* Missing/ignored markers are not project authority. */
      }
    }
    if (directory === policy.root || dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return policy.root;
}
