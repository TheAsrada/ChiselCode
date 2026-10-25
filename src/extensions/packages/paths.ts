import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPath } from "../external/package.js";
export function inside(parent: string, path: string): boolean {
  const rel = relative(
    canonicalPath(resolve(parent)),
    canonicalPath(resolve(path)),
  );
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
export { packageRelativePath } from "../../utils/package-path.js";
