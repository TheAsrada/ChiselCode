import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  type ApplicationPaths,
  applicationPaths,
  isPrivatePath,
  pathContains,
} from "../projects/paths.js";
import { isVerifiedManagedRoot } from "../projects/verified-roots.js";
import { isIgnored, resolveProjectPath } from "../utils/paths.js";
export class IgnoredPathError extends Error {}
/** The editing engine also serves application-owned libraries with their own boundaries. */
export interface FilePathPolicy {
  readonly root: string;
  resolve(candidate: string): Promise<string>;
}
export class WorkspacePolicy implements FilePathPolicy {
  private application?: Promise<ApplicationPaths>;
  constructor(
    readonly root: string,
    readonly ignorePatterns: string[],
  ) {}
  async resolve(candidate: string): Promise<string> {
    const path = await resolveProjectPath(this.root, candidate);
    this.application ??= applicationPaths();
    const paths = await this.application;
    const canonicalRoot = await realpath(this.root);
    if (
      isPrivatePath(paths, canonicalRoot) &&
      !(await isVerifiedManagedRoot(canonicalRoot))
    )
      throw new IgnoredPathError(
        "Служебная папка ChiselCode не является допущенным проектом.",
      );
    // A verified managed tree can see only its own subtree, never siblings/Home.
    // Root admission is performed before execution; this does not grant admission.
    if (isPrivatePath(paths, path) && !isPrivatePath(paths, canonicalRoot))
      throw new IgnoredPathError(
        "Служебные данные ChiselCode недоступны инструментам проекта.",
      );
    if (
      isPrivatePath(paths, path) &&
      !pathContains(await realpath(this.root), path)
    )
      throw new IgnoredPathError(
        "Служебные данные вне рабочей копии недоступны.",
      );
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
