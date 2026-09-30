import { RuntimeError } from "../../runtime/errors.js";
export interface PatchHunk {
  before: string[];
  after: string[];
  anchor?: string;
  atEnd?: boolean;
}
export type ParsedPatchOperation = {
  kind: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  content?: string;
  hunks: PatchHunk[];
};
export function parsePatch(patch: string): ParsedPatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const bad = (message: string): never => {
    throw new RuntimeError("PATCH_CONFLICT", message);
  };
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
    bad("Patch must have Begin/End Patch markers.");
  const operations: ParsedPatchOperation[] = [];
  let current: ParsedPatchOperation | undefined;
  let hunk: PatchHunk | undefined;
  for (const line of lines) {
    const marker = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (marker) {
      const kind = marker[1]?.toLowerCase() as ParsedPatchOperation["kind"];
      current = {
        kind,
        path: marker[2] ?? "",
        hunks: [],
        ...(kind === "add" ? { content: "" } : {}),
      };
      operations.push(current);
      hunk = undefined;
      continue;
    }
    if (!current) bad("Patch content precedes a file marker.");
    if (line.startsWith("*** Move to: ")) {
      if (current?.kind !== "update" || current.moveTo)
        bad("Move requires an Update File marker.");
      if (current) current.moveTo = line.slice(13);
      continue;
    }
    if (current?.kind === "add") {
      if (!line.startsWith("+")) bad("Add File lines must start with +.");
      current.content += `${line.slice(1)}\n`;
      continue;
    }
    if (current?.kind === "delete") bad("Delete File cannot contain hunks.");
    if (line === "*** End of File") {
      if (!hunk) bad("End of File requires a preceding hunk.");
      if (hunk) hunk.atEnd = true;
      continue;
    }
    if (line.startsWith("@@")) {
      hunk = {
        before: [],
        after: [],
        anchor: /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)
          ? undefined
          : line.slice(2).trim() || undefined,
      };
      current?.hunks.push(hunk);
      continue;
    }
    if (!hunk || !/^[ +-]/.test(line))
      bad("Update File requires @@ hunks with context, additions or removals.");
    if (line[0] !== "+") hunk?.before.push(line.slice(1));
    if (line[0] !== "-") hunk?.after.push(line.slice(1));
  }
  if (!operations.length) bad("Patch contains no operations.");
  for (const operation of operations)
    if (
      operation.kind === "update" &&
      !operation.hunks.length &&
      !operation.moveTo
    )
      bad("Update contains no hunks.");
  return operations;
}
export function applyHunks(content: string, hunks: PatchHunk[]): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailing = content.endsWith("\n");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (trailing || content === "") lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.anchor) {
      const found = lines.indexOf(hunk.anchor, cursor);
      if (found < 0)
        throw new RuntimeError(
          "PATCH_CONFLICT",
          `Anchor not found: ${hunk.anchor}`,
        );
      cursor = found + 1;
    }
    const matches: number[] = [];
    for (let i = cursor; i <= lines.length - hunk.before.length; i++)
      if (
        (!hunk.atEnd || i + hunk.before.length === lines.length) &&
        hunk.before.every((line, offset) => lines[i + offset] === line)
      )
        matches.push(i);
    if (matches.length !== 1)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        `Hunk must match uniquely (found ${matches.length}). Add context or an anchor.`,
      );
    const index = matches[0] ?? 0;
    lines.splice(index, hunk.before.length, ...hunk.after);
    cursor = index + hunk.after.length;
  }
  return lines.join(newline) + (trailing ? newline : "");
}
