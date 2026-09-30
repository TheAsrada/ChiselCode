import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeError } from "../runtime/errors.js";
import { estimateTokens } from "./tokenizer.js";
export interface ToolArtifactRef {
  uri: string;
  tokens: number;
}
export class ToolResultStore {
  constructor(private readonly directory: string) {}
  async put(output: string): Promise<ToolArtifactRef> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new RuntimeError(
        "TOOL_EXECUTION_FAILURE",
        "Unsafe artifact directory.",
      );
    const id = randomUUID();
    const file = await open(
      join(await realpath(this.directory), `${id}.txt`),
      "wx",
      0o600,
    );
    try {
      await file.writeFile(output, "utf8");
    } finally {
      await file.close();
    }
    return { uri: `tool-result://${id}`, tokens: estimateTokens(output) };
  }
  async read(uri: string, offset = 0, limit = 200): Promise<string> {
    const match = /^tool-result:\/\/([0-9a-f-]{36})$/.exec(uri);
    if (!match || offset < 0 || limit < 1 || limit > 2000)
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        "Invalid artifact reference or line range.",
      );
    const path = join(this.directory, `${match[1]}.txt`);
    if ((await lstat(path)).isSymbolicLink())
      throw new RuntimeError("TOOL_EXECUTION_FAILURE", "Unsafe artifact file.");
    return (await readFile(path, "utf8"))
      .split("\n")
      .slice(offset, offset + limit)
      .join("\n");
  }
}
