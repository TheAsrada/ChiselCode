import type { RuntimeEvent } from "../runtime/events.js";
import type { ToolSource } from "../tools/types.js";

export type RequestActivityKind =
  | "thinking"
  | "answering"
  | "reading"
  | "searching"
  | "editing"
  | "checking"
  | "git"
  | "fetching"
  | "downloading"
  | "command"
  | "tool"
  | "parallel"
  | "preparing"
  | "context"
  | "approval"
  | "stopping"
  | "failed";
export interface RequestActivity {
  kind: RequestActivityKind;
  label: string;
  short: string;
  icon: string;
  moving: boolean;
}

const phases: Record<RequestActivityKind, Omit<RequestActivity, "kind">> = {
  thinking: { label: "Думаю", short: "Думаю", icon: "✦", moving: true },
  answering: { label: "Отвечаю", short: "Отвечаю", icon: "✦", moving: true },
  reading: { label: "Читаю файлы", short: "Читаю", icon: "▤", moving: true },
  searching: { label: "Ищу", short: "Ищу", icon: "⌕", moving: true },
  editing: {
    label: "Редактирую файлы",
    short: "Редактирую",
    icon: "✎",
    moving: true,
  },
  checking: {
    label: "Проверяю код",
    short: "Проверяю",
    icon: "⚙",
    moving: true,
  },
  git: { label: "Проверяю Git", short: "Git", icon: "⎇", moving: true },
  fetching: {
    label: "Читаю страницу",
    short: "Читаю",
    icon: "≡",
    moving: true,
  },
  downloading: {
    label: "Скачиваю файл",
    short: "Скачиваю",
    icon: "↓",
    moving: true,
  },
  command: {
    label: "Выполняю команду",
    short: "Команда",
    icon: "›",
    moving: true,
  },
  tool: {
    label: "Выполняю инструмент",
    short: "Инструмент",
    icon: "◇",
    moving: true,
  },
  parallel: {
    label: "Выполняю действия",
    short: "Действия",
    icon: "⠿",
    moving: true,
  },
  preparing: {
    label: "Готовлю инструменты",
    short: "Готовлю",
    icon: "◇",
    moving: true,
  },
  context: {
    label: "Готовлю контекст",
    short: "Контекст",
    icon: "≋",
    moving: true,
  },
  approval: {
    label: "Ожидаю подтверждения",
    short: "Нужен ответ",
    icon: "◇",
    moving: false,
  },
  stopping: {
    label: "Останавливаю",
    short: "Остановка",
    icon: "×",
    moving: false,
  },
  failed: {
    label: "Ошибка запроса",
    short: "Ошибка",
    icon: "!",
    moving: false,
  },
};
export function requestActivity(kind: RequestActivityKind): RequestActivity {
  return { kind, ...phases[kind] };
}

/** Classify trusted identity/metadata, never prose or arbitrary shell arguments. */
export function toolActivityKind(
  name: string,
  source?: ToolSource,
): RequestActivityKind {
  if (source?.type === "mcp") return "tool";
  if (source?.type === "web")
    return source.operation === "search"
      ? "searching"
      : source.operation === "fetch"
        ? "fetching"
        : "downloading";
  if (source?.type === "extension" && source.extensionId !== "builtin.lsp")
    return "tool";
  if (
    ["read_file", "read_tool_result", "list_directory", "list_dir"].includes(
      name,
    )
  )
    return "reading";
  if (["search_files", "grep", "glob", "web_search"].includes(name))
    return "searching";
  if (["edit_file", "write_file", "delete_file", "apply_patch"].includes(name))
    return "editing";
  if (name === "run_shell") return "command";
  if (source?.type === "extension" && source.extensionId === "builtin.lsp") {
    if (source.originalName === "diagnostics") return "checking";
    if (["definition", "references", "symbols"].includes(source.originalName))
      return "searching";
    return "tool";
  }
  if (["git_status", "git_diff"].includes(name)) return "git";
  return "tool";
}

type ActiveTool = {
  kind: RequestActivityKind;
  state: "queued" | "approval" | "running";
};
/** Ephemeral, per-foreground-request projection. It never enters model history. */
export class RequestActivityTracker {
  private tools = new Map<string, ActiveTool>();
  private model: RequestActivityKind = "thinking";
  private compacting = false;
  reset(initial: "thinking" | "tool" = "thinking"): RequestActivity {
    this.tools.clear();
    this.model = initial;
    this.compacting = false;
    return this.snapshot();
  }
  stop(): RequestActivity {
    this.tools.clear();
    this.model = "stopping";
    return this.snapshot();
  }
  accept(event: RuntimeEvent): RequestActivity {
    if (this.model === "stopping") return this.snapshot();
    switch (event.type) {
      case "provider_request_started":
      case "provider_thinking_delta":
      case "provider_response_recovery":
        this.model = "thinking";
        break;
      case "provider_text_delta":
        if (event.text) this.model = "answering";
        break;
      case "provider_failed":
        this.model = "failed";
        break;
      case "context_compaction_started":
        this.compacting = true;
        break;
      case "context_compaction_completed":
      case "context_compaction_failed":
        this.compacting = false;
        break;
      case "turn_state":
        if (event.state === "cancelled") return this.stop();
        if (event.state === "failed") this.model = "failed";
        break;
    }
    if (event.invocationId) {
      if (event.type === "tool_completed" || event.type === "tool_failed")
        this.tools.delete(event.invocationId);
      else if (
        event.name &&
        [
          "tool_queued",
          "tool_prepared",
          "tool_approval_requested",
          "tool_started",
        ].includes(event.type)
      ) {
        const prior = this.tools.get(event.invocationId);
        this.model = "thinking";
        this.tools.set(event.invocationId, {
          kind: event.toolSource
            ? toolActivityKind(event.name, event.toolSource)
            : (prior?.kind ?? toolActivityKind(event.name)),
          state:
            event.type === "tool_started"
              ? "running"
              : event.type === "tool_approval_requested"
                ? "approval"
                : (prior?.state ?? "queued"),
        });
      }
    }
    return this.snapshot();
  }
  private snapshot(): RequestActivity {
    if (this.model === "stopping" || this.model === "failed")
      return requestActivity(this.model);
    const tools = [...this.tools.values()];
    if (tools.some((tool) => tool.state === "approval"))
      return requestActivity("approval");
    if (this.compacting) return requestActivity("context");
    const running = tools.filter((tool) => tool.state === "running");
    if (running.length > 1) {
      const same = running.every((tool) => tool.kind === running[0]?.kind);
      const activity = requestActivity(
        same && running[0] ? running[0].kind : "parallel",
      );
      const n = running.length;
      const noun =
        n % 100 >= 11 && n % 100 <= 14
          ? "действий"
          : n % 10 === 1
            ? "действие"
            : n % 10 >= 2 && n % 10 <= 4
              ? "действия"
              : "действий";
      return {
        ...activity,
        label: same
          ? `${activity.label} · ${running.length}`
          : `Выполняю ${running.length} ${noun}`,
        short: `${activity.short} · ${running.length}`,
      };
    }
    if (running[0]) return requestActivity(running[0].kind);
    if (tools.length) return requestActivity("preparing");
    return requestActivity(this.model);
  }
}
