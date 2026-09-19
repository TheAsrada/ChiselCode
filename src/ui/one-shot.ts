import type { AgentResult, ToolExecutionResult } from "../types/domain.js";
import {
  formatToolSummary,
  paint,
  supportsColor,
  toolDisplay,
} from "./theme.js";

export interface OneShotRendererOptions {
  json: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class OneShotRenderer {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;
  private readonly color: boolean;

  constructor(private readonly options: OneShotRendererOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.color = !options.json && supportsColor(this.stderr);
  }

  text(text: string): void {
    if (!this.options.json) this.stdout.write(text);
  }

  thinking(): void {
    // Internal reasoning is not rendered in the non-interactive UI.
  }

  toolStart(name: string, input: Record<string, unknown>): void {
    if (this.options.json) return;
    const meta = toolDisplay(name);
    this.stderr.write(
      `\n${paint("◆", "cyan", this.color)} ${paint(`[${meta.icon}] ${meta.label}`, "bold", this.color)} ${paint(formatToolSummary(name, input), "gray", this.color)}\n`,
    );
  }

  toolResult(name: string, result: ToolExecutionResult): void {
    if (this.options.json || !result.isError) return;
    this.stderr.write(
      `${paint(`✗ ${name}`, "red", this.color)}: ${result.output}\n`,
    );
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
    const tokens =
      result.session.totalTokens.inputTokens +
      result.session.totalTokens.outputTokens;
    if (result.status === "completed") {
      this.stderr.write(
        `${paint(`✓ Готово · ${tokens} токенов · сессия ${result.session.id.slice(0, 8)}`, "green", this.color)}\n`,
      );
    }
    if (result.status === "approval_required") {
      this.stderr.write(
        `${paint("⚠ Нужно подтверждение. Предпросмотр изменений:", "yellow", this.color)}\n${result.pendingApproval?.preview ?? "(нет preview)"}\n`,
      );
    }
    if (result.error)
      this.stderr.write(
        `${paint(`✗ ChiselCode: ${result.error}`, "red", this.color)}\n`,
      );
  }
}

export function exitCodeFor(result: AgentResult): number {
  if (result.status === "completed") return 0;
  if (result.status === "approval_required") return 2;
  if (result.status === "cancelled") return 130;
  return 1;
}
