import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { isIgnored, resolveProjectPath } from "../utils/paths.js";
export class WorkspacePolicy {
  constructor(
    readonly root: string,
    readonly ignorePatterns: string[],
  ) {}
  async resolve(candidate: string): Promise<string> {
    const path = await resolveProjectPath(this.root, candidate);
    const rel = relative(await realpath(this.root), path);
    if (
      isIgnored(rel, this.ignorePatterns) ||
      isIgnored(`${rel}/`, this.ignorePatterns)
    )
      throw new Error(`Path is ignored by project policy: ${rel}`);
    return path;
  }
}
