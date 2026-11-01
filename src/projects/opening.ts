import { abortable } from "../extensions/lifecycle.js";
import { cancelled } from "../runtime/errors.js";
import {
  admitWorkspace,
  revalidateWorkspace,
  type WorkspaceRef,
} from "./admission.js";

export class ProjectOpeningCancelledError extends Error {
  constructor() {
    super("Выбор проекта отменён.");
    this.name = "ProjectOpeningCancelledError";
  }
}

/** Opens only admitted roots. Late completions never commit another owner's selection. */
export class ProjectOpenService<T> {
  private pending?: AbortController;
  private serial = 0;
  private readonly operations = new Map<number, string>();
  constructor(
    private readonly prepare: (workspace: WorkspaceRef) => Promise<T>,
    private readonly changed: () => void = () => {},
    private readonly configPath?: string,
    private readonly timeoutMs = 15_000,
  ) {}
  get roots(): readonly string[] {
    return [...this.operations.values()];
  }
  cancel(): void {
    this.pending?.abort();
    this.serial++;
  }
  async open(
    input: string,
    owner: { base: string; signal: AbortSignal; isCurrent(): boolean },
    commit: (workspace: WorkspaceRef, resource: T) => void,
    beforeAdmission?: () => Promise<void>,
  ): Promise<WorkspaceRef> {
    this.cancel();
    const ticket = this.serial;
    const abort = new AbortController();
    this.pending = abort;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([abort.signal, owner.signal, timeout]);
    const assertOwner = () => {
      cancelled(signal);
      if (ticket !== this.serial || !owner.isCurrent())
        throw new ProjectOpeningCancelledError();
    };
    let committed: WorkspaceRef | undefined;
    const work = (async () => {
      assertOwner();
      if (beforeAdmission) await beforeAdmission();
      assertOwner();
      const workspace = await admitWorkspace(input, {
        base: owner.base,
        allowFile: true,
        source: "picker",
        signal,
        configPath: this.configPath,
      });
      assertOwner();
      this.operations.set(ticket, workspace.root);
      const resource = await this.prepare(workspace);
      await revalidateWorkspace(workspace, signal);
      assertOwner();
      commit(workspace, resource);
      committed = workspace;
      return workspace;
    })();
    void work
      .finally(() => {
        this.operations.delete(ticket);
        this.changed();
      })
      .catch(() => {});
    try {
      return await abortable(() => work, signal);
    } catch (cause) {
      if (committed) return committed;
      if (
        abort.signal.aborted ||
        owner.signal.aborted ||
        ticket !== this.serial ||
        !owner.isCurrent()
      )
        throw new ProjectOpeningCancelledError();
      if (timeout.aborted)
        throw new Error(
          "Истекло время открытия проекта. Проверьте доступность папки и повторите выбор.",
        );
      throw cause;
    } finally {
      if (this.pending === abort) this.pending = undefined;
    }
  }
}
