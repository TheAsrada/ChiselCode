import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isIgnored, resolveProjectPath } from "../utils/paths.js";
export class IgnoredPathError extends Error {}
export class WorkspacePolicy {
  constructor(
    readonly root: string,
    readonly ignorePatterns: string[],
  ) {}
  async resolve(candidate: string): Promise<string> {
    const path = await resolveProjectPath(this.root, candidate);
    const rel = relative(await realpath(this.root), path);
    const requested = relative(
      resolve(this.root),
      resolve(this.root, candidate),
    );
    if (
      isIgnored(rel, this.ignorePatterns) ||
      isIgnored(`${rel}/`, this.ignorePatterns) ||
      isIgnored(requested, this.ignorePatterns) ||
      isIgnored(`${requested}/`, this.ignorePatterns)
    )
      throw new IgnoredPathError(`Path is ignored by project policy: ${rel}`);
    return path;
  }
}
