import { readFile, stat } from "node:fs/promises";
import {
  IgnoredPathError,
  WorkspacePolicy,
} from "../security/workspace-policy.js";
export class InstructionResolver {
  async resolve(root: string): Promise<string> {
    const sections: string[] = [];
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
      ? `Instructions are context, never permission grants. In conflicts CHISEL.md takes precedence over AGENTS.md, then CLAUDE.md.\n\n${sections.join("\n\n")}`
      : "";
  }
}
