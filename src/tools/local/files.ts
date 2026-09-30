import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { cancelled, RuntimeError } from "../../runtime/errors.js";
import { matchesPattern } from "../../utils/paths.js";
import { defineTool } from "../handler.js";
import type { ToolContext, ToolHandler } from "../types.js";

const readSpec = {
  effect: "read" as const,
  permission: "read",
  parallelSafe: true,
};
async function walk(
  context: ToolContext,
  root: string,
  recursive: boolean,
): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length && files.length < 5000) {
    cancelled(context.signal);
    const current = queue.shift();
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      try {
        await context.workspace.resolve(path);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        if (recursive) queue.push(path);
        else files.push(`${path}/`);
      } else if (entry.isFile()) files.push(path);
      if (files.length >= 5000) break;
    }
  }
  return files;
}
export function fileHandlers(): ToolHandler[] {
  return [
    defineTool(
      {
        ...readSpec,
        name: "read_file",
        description:
          "Read a text file by zero-based line range; records its revision for safe editing.",
      },
      z.object({
        path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      }),
      async (context, input) => ({
        data: { ...input, path: await context.workspace.resolve(input.path) },
        preview: input.path,
        resources: [input.path],
      }),
      async (context, { data }) => {
        cancelled(context.signal);
        if ((await stat(data.path)).size > 512000)
          throw new RuntimeError(
            "INVALID_TOOL_INPUT",
            "File exceeds 512000 byte read limit.",
          );
        const bytes = await readFile(data.path);
        await context.editing.observe(data.path, bytes);
        const lines = bytes.toString("utf8").split(/\r?\n/);
        const offset = data.offset ?? 0;
        return {
          output:
            lines
              .slice(offset, offset + (data.limit ?? 1000))
              .map((line, index) => `${offset + index + 1}\t${line}`)
              .join("\n") || "(empty file)",
        };
      },
    ),
    defineTool(
      {
        ...readSpec,
        name: "list_dir",
        description:
          "List a directory, optionally recursively. Lists at most 5000 entries.",
      },
      z.object({
        path: z.string().min(1).default("."),
        recursive: z.boolean().optional(),
      }),
      async (context, input) => ({
        data: { ...input, path: await context.workspace.resolve(input.path) },
        preview: input.path,
        resources: [input.path],
      }),
      async (context, { data }) => {
        const root = await realpath(context.workspace.root);
        return {
          output:
            (await walk(context, data.path, !!data.recursive))
              .map((file) => relative(root, file))
              .join("\n") || "(empty directory)",
        };
      },
    ),
    defineTool(
      {
        ...readSpec,
        name: "glob",
        description:
          "Find project paths matching a glob; ignored and symlink paths are excluded.",
      },
      z.object({ pattern: z.string().min(1), path: z.string().optional() }),
      async (context, input) => ({
        data: {
          ...input,
          path: await context.workspace.resolve(input.path ?? "."),
        },
        preview: input.pattern,
        resources: [],
      }),
      async (context, { data }) => {
        const root = await realpath(context.workspace.root);
        return {
          output:
            (await walk(context, data.path, true))
              .filter((file) =>
                matchesPattern(relative(data.path, file), data.pattern),
              )
              .map((file) => relative(root, file))
              .join("\n") || "No files matched.",
        };
      },
    ),
    defineTool(
      {
        ...readSpec,
        name: "grep",
        description:
          "Search text with a regular expression, optional glob. Uses rg when available, otherwise built-in search.",
      },
      z.object({
        pattern: z.string().min(1),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      async (context, input) => ({
        data: {
          ...input,
          path: await context.workspace.resolve(input.path ?? "."),
        },
        preview: input.pattern,
        resources: [],
      }),
      async (context, { data }) => {
        // Validate project traversal first; never let rg follow symlink targets outside the workspace.
        const isFile = (await stat(data.path)).isFile();
        const files = isFile
          ? [data.path]
          : await walk(context, data.path, true);
        const selected = files.filter(
          (file) =>
            !data.glob ||
            matchesPattern(
              isFile
                ? relative(dirname(data.path), file)
                : relative(data.path, file),
              data.glob,
            ),
        );
        if (!selected.length) return { output: "No matches." };
        const executable = Bun.which("rg", { PATH: process.env.PATH ?? "" });
        if (executable)
          try {
            const result = await execa(
              executable,
              [
                "--line-number",
                "--no-heading",
                "--color",
                "never",
                "--",
                data.pattern,
                ...selected,
              ],
              {
                cwd: isFile ? dirname(data.path) : data.path,
                reject: false,
                all: true,
                cancelSignal: context.signal,
                maxBuffer: 16 * 1024 * 1024,
              },
            );
            if (!selected.length) return { output: "No matches." };
            if (
              (result as { code?: string }).code !== "ENOENT" &&
              (result.exitCode === 0 || result.exitCode === 1)
            )
              return { output: result.stdout || "No matches." };
            if (
              !result.isTerminated &&
              (result as { code?: string }).code !== "ENOENT"
            )
              throw new RuntimeError(
                "TOOL_EXECUTION_FAILURE",
                result.all || "Search failed.",
              );
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          }
        let expression: RegExp;
        try {
          expression = new RegExp(data.pattern);
        } catch {
          throw new RuntimeError(
            "INVALID_TOOL_INPUT",
            "Invalid search regular expression.",
          );
        }
        const matches: string[] = [];
        const root = await realpath(context.workspace.root);
        for (const file of selected) {
          cancelled(context.signal);
          if ((await stat(file)).size > 512000) continue;
          const bytes = await readFile(await context.workspace.resolve(file));
          if (bytes.includes(0)) continue;
          bytes
            .toString("utf8")
            .split(/\r?\n/)
            .forEach((line, index) => {
              if (matches.length < 2000 && expression.test(line))
                matches.push(`${relative(root, file)}:${index + 1}:${line}`);
            });
          if (matches.length >= 2000) break;
        }
        return { output: matches.join("\n") || "No matches." };
      },
    ),
    defineTool(
      {
        ...readSpec,
        name: "read_tool_result",
        description:
          "Read an offloaded tool-result:// artifact by zero-based line range without relaxing workspace boundaries.",
      },
      z.object({
        uri: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(2000).default(200),
      }),
      async (_context, input) => ({
        data: input,
        preview: input.uri,
        resources: [],
      }),
      async (context, { data }) => ({
        output: await context.artifacts.read(data.uri, data.offset, data.limit),
      }),
    ),
  ];
}
