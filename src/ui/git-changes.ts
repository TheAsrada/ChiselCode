import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_FILES = 200;

export interface GitChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitWorkingState {
  root: string;
  branch: string;
  files: GitChangedFile[];
  totalFiles: number;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-C",
      cwd,
      ...(args[0] === "diff"
        ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
        : args),
    ],
    {
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    },
  );
  return stdout;
}

/** Porcelain -z does not quote whitespace or Unicode file names. */
export function parseGitStatus(
  output: string,
): Array<{ path: string; status: string }> {
  const tokens = output.split("\0");
  const result: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const entry = tokens[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    result.push({ path, status });
    if (status.includes("R") || status.includes("C")) index++;
  }
  return result;
}

/** -z rename records carry two subsequent paths; use the destination. */
export function parseGitNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index];
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);
    if (!match) continue;
    let path = match[3] ?? "";
    if (!path) {
      index++; // original path
      path = tokens[++index] ?? ""; // destination path
    }
    if (!path) continue;
    const additions = Number(match[1]) || 0;
    const deletions = Number(match[2]) || 0;
    const previous = result.get(path);
    result.set(path, {
      additions: (previous?.additions ?? 0) + additions,
      deletions: (previous?.deletions ?? 0) + deletions,
    });
  }
  return result;
}

async function untrackedLineCount(root: string, path: string): Promise<number> {
  try {
    const full = join(root, path);
    const info = await stat(full);
    if (!info.isFile() || info.size > 1024 * 1024) return 0;
    const content = await readFile(full);
    if (content.includes(0)) return 0;
    if (content.length === 0) return 0;
    let lines = 0;
    for (const byte of content) if (byte === 10) lines++;
    return lines + (content.at(-1) === 10 ? 0 : 1);
  } catch {
    return 0; // the file may have disappeared during the Git read
  }
}

/** Current working tree, including staged changes and untracked files. */
export async function readGitWorkingState(
  projectPath: string,
): Promise<GitWorkingState | undefined> {
  let root: string;
  try {
    root = (await git(projectPath, "rev-parse", "--show-toplevel")).trim();
  } catch {
    return undefined;
  }
  if (!isAbsolute(root)) return undefined;
  const [statusOutput, branchOutput, diffOutput] = await Promise.all([
    git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    git(root, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "HEAD"),
    git(root, "diff", "--numstat", "-z", "HEAD", "--").catch(async () => {
      const [staged, unstaged] = await Promise.all([
        git(root, "diff", "--cached", "--numstat", "-z", "--"),
        git(root, "diff", "--numstat", "-z", "--"),
      ]);
      return staged + unstaged;
    }),
  ]);
  const status = parseGitStatus(statusOutput);
  const stats = parseGitNumstat(diffOutput);
  const files = await Promise.all(
    status.slice(0, MAX_FILES).map(async ({ path, status: fileStatus }) => {
      const diff = stats.get(path);
      return {
        path,
        status: fileStatus,
        additions:
          fileStatus === "??"
            ? await untrackedLineCount(root, path)
            : (diff?.additions ?? 0),
        deletions: diff?.deletions ?? 0,
      };
    }),
  );
  return {
    root,
    branch: branchOutput.trim(),
    files,
    totalFiles: status.length,
  };
}

/** Prevent slow reads from a previous project from overwriting the new one. */
export class GitChangesSource {
  private revision = 0;
  private lastStarted = 0;
  private timer?: ReturnType<typeof setTimeout>;

  refresh(
    projectPath: string,
    publish: (state: GitWorkingState | undefined) => void,
  ): void {
    const revision = ++this.revision;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, 250 - (Date.now() - this.lastStarted));
    this.timer = setTimeout(async () => {
      this.lastStarted = Date.now();
      const state = await readGitWorkingState(projectPath).catch(
        () => undefined,
      );
      if (revision === this.revision) publish(state);
    }, delay);
  }

  dispose(): void {
    ++this.revision;
    if (this.timer) clearTimeout(this.timer);
  }
}
