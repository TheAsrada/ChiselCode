import type { AgentResult, ToolExecutionResult } from "../types/domain.js";

export interface OneShotRendererOptions {
  json: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class OneShotRenderer {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;

  constructor(private readonly options: OneShotRendererOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  text(text: string): void {
    if (!this.options.json) this.stdout.write(text);
  }

  thinking(): void {
    // Internal reasoning is not rendered in the non-interactive UI.
  }

  toolStart(name: string, input: Record<string, unknown>): void {
    if (!this.options.json)
      this.stderr.write(`\n[chisel] ${name} ${JSON.stringify(input)}\n`);
  }

  toolResult(name: string, result: ToolExecutionResult): void {
    if (!this.options.json && result.isError)
      this.stderr.write(`[chisel] ${name}: ${result.output}\n`);
  }

  complete(result: AgentResult): void {
    if (this.options.json) {
      this.stdout.write(
        `${JSON.stringify({
          status: result.status,
          text: result.text,
          sessionId: result.session.id,
          totalTokens: result.session.totalTokens,
          totalCost: result.session.totalCost,
          error: result.error,
          pendingApproval: result.pendingApproval,
        })}\n`,
      );
      return;
    }

    if (result.text && !result.text.endsWith("\n")) this.stdout.write("\n");
    if (result.status === "approval_required") {
      this.stderr.write(
        `Approval required. Dry-run preview:\n${result.pendingApproval?.preview ?? "(no preview)"}\n`,
      );
    }
    if (result.error) this.stderr.write(`ChiselCode: ${result.error}\n`);
  }
}

export function exitCodeFor(result: AgentResult): number {
  if (result.status === "completed") return 0;
  if (result.status === "approval_required") return 2;
  if (result.status === "cancelled") return 130;
  return 1;
}
