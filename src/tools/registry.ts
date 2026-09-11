import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { createPatch } from "diff";
import { execa } from "execa";
import { z } from "zod";
import type { ApprovalGate } from "../security/approval.js";
import type {
  Session,
  ToolDefinition,
  ToolExecutionResult,
  ToolName,
  UndoEntry,
} from "../types/domain.js";
import {
  ensureParentDirectory,
  exists,
  isIgnored,
  matchesPattern,
  resolveProjectPath,
} from "../utils/paths.js";

const MAX_READ_BYTES = 512_000;
const MAX_RESULT_LINES = 2_000;
const MAX_FILE_LIST = 5_000;

const schemas = {
  read_file: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(5_000).optional(),
  }),
  list_dir: z.object({
    path: z.string().min(1).default("."),
    recursive: z.boolean().optional(),
  }),
  glob: z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
  }),
  grep: z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
  }),
  write_file: z.object({ path: z.string().min(1), content: z.string() }),
  edit_file: z.object({
    path: z.string().min(1),
    old_str: z.string().min(1),
    new_str: z.string(),
  }),
  delete_file: z.object({ path: z.string().min(1) }),
  run_shell: z.object({
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeout: z.number().int().min(1_000).max(600_000).optional(),
  }),
  git_diff: z.object({ path: z.string().min(1).optional() }),
  git_commit: z.object({ message: z.string().min(1).max(500) }),
} as const;

type InputMap = { [Name in ToolName]: z.infer<(typeof schemas)[Name]> };

const definitions: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a text file by line range.",
    inputSchema: z.toJSONSchema(schemas.read_file),
    requiresApproval: false,
  },
  {
    name: "list_dir",
    description: "List files and directories under a project path.",
    inputSchema: z.toJSONSchema(schemas.list_dir),
    requiresApproval: false,
  },
  {
    name: "glob",
    description: "Find project files matching a glob pattern.",
    inputSchema: z.toJSONSchema(schemas.glob),
    requiresApproval: false,
  },
  {
    name: "grep",
    description: "Search file contents with ripgrep.",
    inputSchema: z.toJSONSchema(schemas.grep),
    requiresApproval: false,
  },
  {
    name: "write_file",
    description: "Create a file or replace a previously read file.",
    inputSchema: z.toJSONSchema(schemas.write_file),
    requiresApproval: true,
  },
  {
    name: "edit_file",
    description: "Replace one unique literal string in a previously read file.",
    inputSchema: z.toJSONSchema(schemas.edit_file),
    requiresApproval: true,
  },
  {
    name: "delete_file",
    description: "Delete a project file.",
    inputSchema: z.toJSONSchema(schemas.delete_file),
    requiresApproval: true,
  },
  {
    name: "run_shell",
    description: "Run a shell command inside the project.",
    inputSchema: z.toJSONSchema(schemas.run_shell),
    requiresApproval: true,
  },
  {
    name: "git_diff",
    description: "Show uncommitted git changes.",
    inputSchema: z.toJSONSchema(schemas.git_diff),
    requiresApproval: false,
  },
  {
    name: "git_commit",
    description: "Create a git commit with a message.",
    inputSchema: z.toJSONSchema(schemas.git_commit),
    requiresApproval: true,
  },
];

export class ToolRegistry {
  private readonly readPaths = new Set<string>();

  constructor(
    private readonly projectRoot: string,
    private readonly ignorePatterns: string[],
    private readonly approvalGate: ApprovalGate,
    private readonly session: Session,
  ) {}

  getDefinitions(): ToolDefinition[] {
    return definitions;
  }

  async execute(
    name: ToolName,
    rawInput: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    try {
      switch (name) {
        case "read_file":
          return await this.readFile(schemas.read_file.parse(rawInput));
        case "list_dir":
          return await this.listDirectory(schemas.list_dir.parse(rawInput));
        case "glob":
          return await this.glob(schemas.glob.parse(rawInput));
        case "grep":
          return await this.grep(schemas.grep.parse(rawInput));
        case "write_file":
          return await this.writeFile(schemas.write_file.parse(rawInput));
        case "edit_file":
          return await this.editFile(schemas.edit_file.parse(rawInput));
        case "delete_file":
          return await this.deleteFile(schemas.delete_file.parse(rawInput));
        case "run_shell":
          return await this.runShell(schemas.run_shell.parse(rawInput));
        case "git_diff":
          return await this.gitDiff(schemas.git_diff.parse(rawInput));
        case "git_commit":
          return await this.gitCommit(schemas.git_commit.parse(rawInput));
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : "Unknown tool error.",
        isError: true,
      };
    }
  }

  private async readFile(
    input: InputMap["read_file"],
  ): Promise<ToolExecutionResult> {
    const path = await this.safePath(input.path);
    const info = await stat(path);
    if (info.size > MAX_READ_BYTES)
      throw new Error(`File exceeds ${MAX_READ_BYTES} byte read limit.`);
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 1_000;
    this.readPaths.add(path);
    const numbered = lines
      .slice(offset, offset + limit)
      .map((line, index) => `${offset + index + 1}\t${line}`)
      .join("\n");
    return { output: numbered || "(empty file)" };
  }

  private async listDirectory(
    input: InputMap["list_dir"],
  ): Promise<ToolExecutionResult> {
    const path = await this.safePath(input.path);
    const files = await this.walk(path, Boolean(input.recursive));
    return {
      output: limitLines(
        files.map((file) => relative(this.projectRoot, file)).join("\n"),
        MAX_FILE_LIST,
      ),
    };
  }

  private async glob(input: InputMap["glob"]): Promise<ToolExecutionResult> {
    const base = await this.safePath(input.path ?? ".");
    const files = await this.walk(base, true);
    const matches = files
      .map((file) => relative(base, file))
      .filter((file) => matchesPattern(file, input.pattern))
      .slice(0, MAX_FILE_LIST)
      .map((file) => relative(this.projectRoot, `${base}/${file}`));
    return { output: matches.join("\n") || "No files matched." };
  }

  private async grep(input: InputMap["grep"]): Promise<ToolExecutionResult> {
    const cwd = await this.safePath(input.path ?? ".");
    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(MAX_RESULT_LINES),
    ];
    if (input.glob) args.push("--glob", input.glob);
    for (const ignored of this.ignorePatterns)
      args.push("--glob", `!${ignored}`);
    args.push("--", input.pattern, ".");
    const result = await execa("rg", args, { cwd, reject: false, all: true });
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error(result.all || `ripgrep exited with ${result.exitCode}`);
    return {
      output: limitLines(result.stdout || "No matches.", MAX_RESULT_LINES),
    };
  }

  private async writeFile(
    input: InputMap["write_file"],
  ): Promise<ToolExecutionResult> {
    const path = await this.safePath(input.path);
    const fileExists = await exists(path);
    if (fileExists && !this.readPaths.has(path))
      throw new Error(
        "Read-before-write policy: read this existing file first.",
      );
    const before = fileExists ? await readFile(path, "utf8") : null;
    const preview = createPatch(
      relative(this.projectRoot, path),
      before ?? "",
      input.content,
      "before",
      "after",
    );
    const decision = await this.approvalGate.decide({
      tool: "write_file",
      preview,
    });
    if (decision !== "approved") return approvalResult(decision, preview);
    await ensureParentDirectory(path);
    await writeFile(path, input.content, "utf8");
    this.recordUndo(path, before, input.content);
    return { output: `Wrote ${relative(this.projectRoot, path)}.`, preview };
  }

  private async editFile(
    input: InputMap["edit_file"],
  ): Promise<ToolExecutionResult> {
    const path = await this.safePath(input.path);
    if (!this.readPaths.has(path))
      throw new Error("Read-before-write policy: read this file first.");
    const before = await readFile(path, "utf8");
    const occurrences = before.split(input.old_str).length - 1;
    if (occurrences === 0)
      throw new Error("old_str was not found in the file.");
    if (occurrences > 1)
      throw new Error(
        "old_str occurs more than once; include more context for a unique replacement.",
      );
    const after = before.replace(input.old_str, input.new_str);
    const preview = createPatch(
      relative(this.projectRoot, path),
      before,
      after,
      "before",
      "after",
    );
    const decision = await this.approvalGate.decide({
      tool: "edit_file",
      preview,
    });
    if (decision !== "approved") return approvalResult(decision, preview);
    await writeFile(path, after, "utf8");
    this.recordUndo(path, before, after);
    return { output: `Edited ${relative(this.projectRoot, path)}.`, preview };
  }

  private async deleteFile(
    input: InputMap["delete_file"],
  ): Promise<ToolExecutionResult> {
    const path = await this.safePath(input.path);
    if (!this.readPaths.has(path))
      throw new Error("Read-before-write policy: read this file first.");
    const before = await readFile(path, "utf8");
    const preview = createPatch(
      relative(this.projectRoot, path),
      before,
      "",
      "before",
      "after",
    );
    const decision = await this.approvalGate.decide({
      tool: "delete_file",
      preview,
    });
    if (decision !== "approved") return approvalResult(decision, preview);
    await rm(path);
    this.recordUndo(path, before, null);
    return { output: `Deleted ${relative(this.projectRoot, path)}.`, preview };
  }

  private async runShell(
    input: InputMap["run_shell"],
  ): Promise<ToolExecutionResult> {
    const cwd = await this.safePath(input.cwd ?? ".");
    const preview = `$ ${input.command}\nWorking directory: ${relative(this.projectRoot, cwd) || "."}`;
    const decision = await this.approvalGate.decide({
      tool: "run_shell",
      preview,
      command: input.command,
    });
    if (decision !== "approved") return approvalResult(decision, preview);
    const result = await execa(input.command, {
      cwd,
      shell: true,
      timeout: input.timeout ?? 120_000,
      reject: false,
      all: true,
    });
    return {
      output: limitLines(
        result.all || `(exit ${result.exitCode})`,
        MAX_RESULT_LINES,
      ),
      isError: result.exitCode !== 0,
    };
  }

  private async gitDiff(
    input: InputMap["git_diff"],
  ): Promise<ToolExecutionResult> {
    const args = ["diff", "--"];
    if (input.path) args.push(input.path);
    const result = await execa("git", args, {
      cwd: this.projectRoot,
      reject: false,
      all: true,
    });
    return {
      output: limitLines(
        result.all || "No uncommitted changes.",
        MAX_RESULT_LINES,
      ),
      isError: result.exitCode !== 0,
    };
  }

  private async gitCommit(
    input: InputMap["git_commit"],
  ): Promise<ToolExecutionResult> {
    const preview = `git commit -m ${JSON.stringify(input.message)}`;
    const decision = await this.approvalGate.decide({
      tool: "git_commit",
      preview,
    });
    if (decision !== "approved") return approvalResult(decision, preview);
    const result = await execa("git", ["commit", "-m", input.message], {
      cwd: this.projectRoot,
      reject: false,
      all: true,
    });
    return {
      output: result.all || `(exit ${result.exitCode})`,
      isError: result.exitCode !== 0,
    };
  }

  private async safePath(candidate: string): Promise<string> {
    const path = await resolveProjectPath(this.projectRoot, candidate);
    const rel = relative(this.projectRoot, path);
    if (isIgnored(rel, this.ignorePatterns))
      throw new Error(`Path is ignored by project policy: ${rel}`);
    return path;
  }

  private async walk(root: string, recursive: boolean): Promise<string[]> {
    const result: string[] = [];
    const queue = [root];
    while (queue.length && result.length < MAX_FILE_LIST) {
      const current = queue.shift();
      if (!current) break;
      const entries = await Array.fromAsync(
        new Bun.Glob("*").scan({
          cwd: current,
          onlyFiles: false,
          absolute: true,
        }),
      );
      for (const entry of entries) {
        const rel = relative(this.projectRoot, entry);
        if (isIgnored(rel, this.ignorePatterns)) continue;
        const details = await stat(entry);
        if (details.isDirectory()) {
          if (recursive) queue.push(entry);
        } else if (details.isFile()) {
          result.push(entry);
        }
      }
    }
    return result;
  }

  private recordUndo(
    path: string,
    before: string | null,
    after: string | null,
  ): void {
    const entry: UndoEntry = {
      path,
      before,
      after,
      createdAt: new Date().toISOString(),
    };
    this.session.undoStack.push(entry);
  }
}

function approvalResult(
  decision: string,
  preview: string,
): ToolExecutionResult {
  return {
    output:
      decision === "denied"
        ? "User denied this action."
        : "Approval required but unavailable in non-interactive mode.",
    isError: true,
    requiresApproval: decision === "unavailable",
    preview,
  };
}

function limitLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n... output truncated after ${maxLines} lines`;
}
