import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { WorkspacePolicy } from "../security/workspace-policy.js";
import { LSP_LIMITS } from "./limits.js";

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface LspFile {
  path: string;
  relativePath: string;
  uri: string;
  languageId: string;
  text: string;
  bytes: Buffer;
  hash: string;
}
export interface LspReadPort {
  policy: WorkspacePolicy;
  signal?: AbortSignal;
  observe?(path: string, bytes: Buffer): Promise<unknown>;
}
const languages: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
};
export async function readLspFile(
  port: LspReadPort,
  candidate: string,
): Promise<LspFile> {
  cancelled(port.signal);
  const path = await port.policy.resolve(candidate);
  const languageId = languages[extname(path).toLowerCase()];
  if (!languageId)
    throw new RuntimeError(
      "LSP_UNSUPPORTED",
      "LSP supports .ts, .tsx, .js and .jsx files.",
    );
  const handle = await open(path, "r");
  try {
    if ((await port.policy.resolve(candidate)) !== path)
      throw new RuntimeError(
        "STALE_FILE_REVISION",
        "LSP document path changed.",
      );
    const before = await handle.stat();
    if (!before.isFile() || before.size > LSP_LIMITS.documentBytes)
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        "LSP requires a regular file of at most 512000 bytes.",
      );
    const buffer = Buffer.alloc(
      Math.min(LSP_LIMITS.documentBytes + 1, before.size + 1),
    );
    let length = 0;
    while (length < buffer.length) {
      cancelled(port.signal);
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    cancelled(port.signal);
    if (
      length > LSP_LIMITS.documentBytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      length !== after.size
    )
      throw new RuntimeError(
        "STALE_FILE_REVISION",
        "LSP document changed while reading or exceeded its size limit.",
      );
    if ((await port.policy.resolve(candidate)) !== path)
      throw new RuntimeError(
        "STALE_FILE_REVISION",
        "LSP document path changed.",
      );
    const bytes = buffer.subarray(0, length);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("Binary content.");
    } catch {
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        "LSP requires valid UTF-8 text without binary content.",
      );
    }
    await port.observe?.(path, bytes);
    return {
      path,
      relativePath: relative(port.policy.root, path).replaceAll("\\", "/"),
      uri: pathToFileURL(path).href,
      languageId,
      text,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}
export function validatePosition(text: string, position: Position): void {
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Position must use zero-based UTF-16 integers.",
    );
  const line = text.split(/\r\n|\n|\r/u)[position.line];
  if (line === undefined || position.character > line.length)
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Position is outside the document.",
    );
  const previous = line.charCodeAt(position.character - 1);
  const next = line.charCodeAt(position.character);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Position splits a UTF-16 surrogate pair.",
    );
}
export function documentEnd(text: string): Position {
  const lines = text.split(/\r\n|\n|\r/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
export function safeRange(value: unknown): Range | undefined {
  if (!value || typeof value !== "object") return;
  const { start, end } = value as Range;
  const valid = (p: Position) =>
    p &&
    Number.isSafeInteger(p.line) &&
    Number.isSafeInteger(p.character) &&
    p.line >= 0 &&
    p.character >= 0;
  if (
    !valid(start) ||
    !valid(end) ||
    end.line < start.line ||
    (end.line === start.line && end.character < start.character)
  )
    return;
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}
export async function resolveLspUri(
  policy: WorkspacePolicy,
  uri: unknown,
): Promise<string | undefined> {
  if (typeof uri !== "string" || uri.length > 32768) return;
  try {
    const url = new URL(uri);
    if (
      url.protocol !== "file:" ||
      url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const path = await policy.resolve(fileURLToPath(url));
    return path;
  } catch {
    return;
  }
}
export async function permittedLocation(
  policy: WorkspacePolicy,
  value: unknown,
): Promise<{ path: string; range: Range } | undefined> {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  const range = safeRange(
    item.targetSelectionRange ?? item.range ?? item.targetRange,
  );
  if (!range) return;
  const path = await resolveLspUri(policy, item.targetUri ?? item.uri);
  return path
    ? { path: relative(policy.root, path).replaceAll("\\", "/"), range }
    : undefined;
}
