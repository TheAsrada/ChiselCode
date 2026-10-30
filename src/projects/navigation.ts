import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cancelled } from "../runtime/errors.js";

export interface DirectoryPage {
  path: string;
  parent: string;
  directories: string[];
  more: boolean;
  offset: number;
}
export async function navigationDirectory(): Promise<string> {
  return realpath(homedir());
}
/** Bounded names only: navigation never loads project configuration or instructions. */
export async function directoryPage(
  input: string,
  base: string,
  signal?: AbortSignal,
  offset = 0,
): Promise<DirectoryPage> {
  cancelled(signal);
  let path = resolve(base, input.trim().replace(/^["']([\s\S]*)["']$/, "$1"));
  if ((await stat(path)).isFile()) path = dirname(path);
  path = await realpath(path);
  const directory = await opendir(path);
  const directories: string[] = [];
  let seen = 0,
    scanned = 0,
    more = false;
  try {
    for await (const entry of directory) {
      cancelled(signal);
      if (seen++ < offset) continue;
      if (scanned === 200) {
        more = true;
        break;
      }
      scanned++;
      if (
        !entry.isDirectory() &&
        !(
          entry.isSymbolicLink() &&
          (
            await stat(join(path, entry.name)).catch(() => undefined)
          )?.isDirectory()
        )
      )
        continue;
      directories.push(join(path, entry.name));
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return {
    path,
    parent: dirname(path),
    directories,
    more,
    offset: offset + scanned,
  };
}
