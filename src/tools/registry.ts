import { randomUUID } from "node:crypto";
import type { ToolGuardPort } from "../extensions/contracts.js";
import type { ApprovalGate } from "../security/approval.js";
import type { Skill } from "../skills/skills.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import { createLocalToolRuntime } from "./local-runtime.js";

/** Compatibility boundary only. All tool behavior lives in handlers/executor/editing. */
export class ToolRegistry {
  readonly runtime: ReturnType<typeof createLocalToolRuntime>;
  constructor(
    projectRoot: string,
    ignorePatterns: string[],
    approvalGate: ApprovalGate,
    session: Session,
    skills: readonly Skill[] = [],
    options: { toolGuards?: ToolGuardPort } = {},
  ) {
    this.runtime = createLocalToolRuntime(
      projectRoot,
      ignorePatterns,
      approvalGate,
      session,
      skills,
      options,
    );
  }
  getDefinitions() {
    return this.runtime.catalog.selectForTurn();
  }
  execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    return this.runtime.executor.execute({ id: randomUUID(), name, input });
  }
}
