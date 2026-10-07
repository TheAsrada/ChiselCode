import type { ContextCompactionRecord } from "../context/types.js";
import type { ToolSource } from "../tools/types.js";
import type { AgentResult, ToolExecutionResult } from "../types/domain.js";
import { compactionNotice } from "./context-compaction.js";
import { extensionResultLabel, extensionToolLabel } from "./extension-tool.js";
import {
  FAIL_MARK,
  formatToolSummary,
  paint,
  supportsColor,
  toolDisplay,
  WARN_MARK,
} from "./theme.js";
import { webResultSummary } from "./web-result.js";

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

  compaction(record: ContextCompactionRecord): void {
    if (!this.options.json)
      this.stderr.write(
        `\n${paint(compactionNotice(record), "cyan", this.color)}\n`,
      );
  }

  toolStart(
    name: string,
    input: Record<string, unknown>,
    source?: ToolSource,
  ): void {
    if (this.options.json) return;
    const extension = extensionToolLabel(source);
    if (extension) {
      this.stderr.write(`\n${extension}\n`);
      return;
    }
    const meta = toolDisplay(name);
    this.stderr.write(
      `\n${paint("*", "cyan", this.color)} ${paint(`[${meta.icon}] ${meta.label}`, "bold", this.color)} ${paint(formatToolSummary(name, input), "gray", this.color)}\n`,
    );
  }

  toolResult(name: string, result: ToolExecutionResult): void {
    if (this.options.json) return;
    const summary = webResultSummary(result);
    const extension = extensionResultLabel(result);
    if (!result.isError) {
      if (extension) this.stderr.write(`${extension} · готово\n`);
      else if (summary) this.stderr.write(`${summary}\n`);
      return;
    }
    this.stderr.write(
      `${paint(`${FAIL_MARK} ${extension ?? name}`, "red", this.color)}: ${result.output}\n`,
    );
  }

  complete(result: AgentResult): void {
    if (this.options.json) {
      this.stdout.write(
        `${JSON.stringify({
          status: result.status,
          text: result.text,
          sessionId: result.session.id,
          mode: result.session.mode ?? "build",
          approvalMode: result.session.approvalMode ?? "default",
          totalTokens: result.session.totalTokens,
          totalCost:
            result.session.costEstimate?.source === "unknown"
              ? undefined
              : (result.session.costEstimate?.usd ?? result.session.totalCost),
          costEstimate: result.session.costEstimate,
          error: result.error,
          errorCode: result.errorCode,
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
        `${paint(`+ Готово | ${tokens} токенов | сессия ${result.session.id.slice(0, 8)}`, "green", this.color)}\n`,
      );
    }
    if (result.status === "approval_required") {
      this.stderr.write(
        `${paint(`${WARN_MARK} Нужно подтверждение. Предпросмотр изменений:`, "yellow", this.color)}\n${result.pendingApproval?.preview ?? "(нет preview)"}\n`,
      );
    }
    if (result.error)
      this.stderr.write(
        `${paint(`${FAIL_MARK} ChiselCode: ${result.error}`, "red", this.color)}\n`,
      );
  }
}

export function exitCodeFor(result: AgentResult): number {
  if (result.status === "completed") return 0;
  if (result.status === "approval_required") return 2;
  if (result.status === "cancelled") return 130;
  return 1;
}
