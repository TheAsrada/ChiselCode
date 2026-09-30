import { createHash } from "node:crypto";
import type { FileRevision } from "../../types/domain.js";
export function revision(content: string | Buffer): FileRevision {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
export function sameRevision(a?: FileRevision, b?: FileRevision): boolean {
  return a?.sha256 === b?.sha256 && a?.size === b?.size;
}
