import {
  type CommandProjection,
  composeCommandProjection,
} from "../commands/slash.js";
import type {
  ExtensionHost,
  WorkspaceExtensionScope,
} from "../extensions/host.js";
import { abortable, safeDiagnostic } from "../extensions/lifecycle.js";
import { invocableSkills, loadSkills, type Skill } from "../skills/skills.js";

export interface WorkspaceCommandSnapshot {
  readonly projection: CommandProjection;
  readonly skills: readonly Skill[];
  readonly scope?: WorkspaceExtensionScope;
  readonly error?: string;
}
export interface WorkspaceCommandsPort {
  load(root: string, signal?: AbortSignal): Promise<WorkspaceCommandSnapshot>;
}

/** Application-owned composition. Listing activates definitions, never MCP/model runtimes. */
export class WorkspaceCommands implements WorkspaceCommandsPort {
  private readonly scopes = new Map<string, WorkspaceExtensionScope>();
  constructor(
    private readonly host: ExtensionHost,
    private readonly signal?: AbortSignal,
  ) {}
  /** UI-only reads never wait for activation; dispatch still awaits a fresh ready scope. */
  current(root: string): WorkspaceCommandSnapshot {
    const skills = loadSkills(root);
    const scope = this.scopes.get(root);
    try {
      return {
        projection: composeCommandProjection(
          invocableSkills(skills),
          scope?.commands.descriptors() ?? [],
        ),
        skills,
        scope,
      };
    } catch (error) {
      return {
        projection: composeCommandProjection(invocableSkills(skills)),
        skills,
        error: safeDiagnostic(
          error instanceof Error
            ? error.message
            : "Extension commands could not be attached.",
        ),
      };
    }
  }
  async load(
    root: string,
    operation?: AbortSignal,
  ): Promise<WorkspaceCommandSnapshot> {
    const skills = loadSkills(root);
    const base = composeCommandProjection(invocableSkills(skills));
    try {
      const signal =
        this.signal && operation
          ? AbortSignal.any([this.signal, operation])
          : (operation ?? this.signal);
      const scope = await abortable(() => this.host.open(root), signal);
      // Read skills again after asynchronous activation: a new skill must not be intercepted.
      scope.assertUsable();
      this.scopes.set(root, scope);
      return this.current(root);
    } catch (error) {
      return {
        projection: base,
        skills,
        error: safeDiagnostic(
          error instanceof Error
            ? error.message
            : "Extension workspace could not be opened.",
        ),
      };
    }
  }
}
