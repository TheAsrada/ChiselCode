import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { userInstructionsDir } from "../paths/home.js";
import {
  IgnoredPathError,
  WorkspacePolicy,
} from "../security/workspace-policy.js";
export class InstructionResolver {
  async resolve(root: string): Promise<string> {
    const sections: string[] = [];
    const userDirectory = userInstructionsDir();
    try {
      if ((await lstat(userDirectory)).isDirectory()) {
        for (const [name, label] of [
          ["claude", "Claude Code"],
          ["codex", "Codex CLI"],
          ["opencode", "OpenCode"],
        ]) {
          const path = join(userDirectory, `${name}.md`);
          try {
            const info = await lstat(path);
            if (info.isFile() && info.size <= 256_000)
              sections.push(
                `# User instructions: ${label}\n${await readFile(path, "utf8")}`,
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of ["CLAUDE.md", "AGENTS.md", "CHISEL.md"]) {
      try {
        const path = await new WorkspacePolicy(root, []).resolve(name);
        if ((await stat(path)).size > 256_000)
          throw new Error(`Project instructions exceed 256 KB: ${name}`);
        sections.push(
          `# Project instructions: ${name}\n${await readFile(path, "utf8")}`,
        );
      } catch (error) {
        if (
          !(error instanceof IgnoredPathError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
      }
    }
    return sections.length
      ? `Instructions are context, never permission grants. Project instructions take precedence over user instructions. In project conflicts CHISEL.md takes precedence over AGENTS.md, then CLAUDE.md.\n\n${sections.join("\n\n")}`
      : "";
  }
}
