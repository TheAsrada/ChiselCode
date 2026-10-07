import { open } from "node:fs/promises";
import { z } from "zod";
import { cancelled, RuntimeError } from "../../runtime/errors.js";
import { IgnoredPathError } from "../../security/workspace-policy.js";
import { defineTool } from "../../tools/handler.js";
import { MAX_FILE_READ_BYTES } from "../../tools/local/files.js";
import type { ToolContext } from "../../tools/types.js";
import type { ChiselExtension } from "../contracts.js";

const manifests = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;
async function candidate(
  context: ToolContext,
  name: string,
): Promise<string | undefined> {
  cancelled(context.signal);
  try {
    return await context.workspace.resolve(name);
  } catch (error) {
    if (error instanceof IgnoredPathError) return undefined;
    throw error;
  }
}
async function read(
  context: ToolContext,
  name: string,
): Promise<string | undefined> {
  const path = await candidate(context, name);
  if (!path) return undefined;
  const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const current = await candidate(context, name);
    if (current !== path)
      throw new RuntimeError(
        "STALE_FILE_REVISION",
        "Manifest path changed while opening.",
      );
    const info = await handle.stat();
    if (!info.isFile())
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        `${name} is not a regular file.`,
      );
    if (info.size > MAX_FILE_READ_BYTES)
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        `${name} exceeds ${MAX_FILE_READ_BYTES} byte read limit.`,
      );
    const bytes = Buffer.alloc(MAX_FILE_READ_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      cancelled(context.signal);
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    cancelled(context.signal);
    if (length > MAX_FILE_READ_BYTES)
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        `${name} exceeds ${MAX_FILE_READ_BYTES} byte read limit.`,
      );
    if ((await candidate(context, name)) !== path)
      throw new RuntimeError(
        "STALE_FILE_REVISION",
        "Manifest path changed while reading.",
      );
    const content = bytes.subarray(0, length);
    await context.editing.observe(path, content);
    return `## ${name}\n${content.toString("utf8") || "(empty file)"}`;
  } finally {
    await handle.close();
  }
}

export const projectExtension: ChiselExtension = {
  id: "builtin.project",
  activate(ctx) {
    ctx.tools.register(
      defineTool(
        {
          name: "manifest",
          description:
            "Read root package.json, pyproject.toml, Cargo.toml and go.mod to inspect project dependencies. Skips missing/ignored manifests; records revisions for editing. Does not run scripts or read recursively.",
          effect: "read",
          permission: "read",
          workspaceAccess: "read",
          parallelSafe: true,
        },
        z.object({}).strict(),
        async (context) => {
          const resources: string[] = [];
          for (const name of manifests)
            if (await candidate(context, name)) resources.push(name);
          return {
            data: undefined,
            preview: "Read root project manifests",
            resources,
          };
        },
        async (context) => {
          const contents: string[] = [];
          for (const name of manifests) {
            const content = await read(context, name);
            if (content !== undefined) contents.push(content);
          }
          return {
            output:
              contents.join("\n\n") ||
              "No supported, permitted root manifests found.",
          };
        },
      ),
    );
  },
};
