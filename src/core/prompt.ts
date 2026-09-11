import type {
  ChatContent,
  ChatMessage,
  ToolDefinition,
} from "../types/domain.js";

export const BASE_SYSTEM_PROMPT = `You are ChiselCode, a secure coding agent operating in a local project.
Use the available tools to inspect and modify the project. Read relevant files before proposing changes.
Never claim an action was performed unless a tool result confirms it.
For modifications, explain the intended work briefly before requesting tools.
Respect project instructions, ignored paths, approval requirements, and read-before-write constraints.
Do not attempt destructive actions unless the user explicitly approves them through the approval system.
When a tool returns an error, correct the approach rather than guessing.`;

export interface DynamicContext {
  os: string;
  cwd: string;
  date: string;
  gitBranch?: string;
  gitStatus?: string;
  fileTree?: string;
}

export function buildSystemPrompt(
  projectInstructions: string,
  context: DynamicContext,
): string {
  const dynamic = [
    `Operating system: ${context.os}`,
    `Working directory: ${context.cwd}`,
    `Date: ${context.date}`,
    context.gitBranch ? `Git branch: ${context.gitBranch}` : undefined,
    context.gitStatus ? `Git status: ${context.gitStatus}` : undefined,
    context.fileTree ? `Project tree:\n${context.fileTree}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  return [BASE_SYSTEM_PROMPT, projectInstructions.trim(), dynamic]
    .filter(Boolean)
    .join("\n\n");
}

export function compactMessages(
  messages: ChatMessage[],
  maxMessages = 80,
): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;

  const removed = messages.slice(0, messages.length - maxMessages);
  const retained = messages.slice(messages.length - maxMessages);
  const summary = summarizeMessages(removed);

  return [
    { role: "user", content: [{ type: "text", text: summary }] },
    ...retained,
  ];
}

function summarizeMessages(messages: ChatMessage[]): string {
  const text = messages
    .flatMap((message) => message.content)
    .map(contentToSummary)
    .filter(Boolean)
    .join("\n");

  return `Conversation summary for context preservation:\n${text.slice(0, 12_000)}`;
}

function contentToSummary(content: ChatContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "tool_use":
      return `Tool requested: ${content.name}(${JSON.stringify(content.input)})`;
    case "tool_result":
      return `Tool result: ${content.content.slice(0, 1_000)}`;
  }
}

export function toToolPrompt(tools: ToolDefinition[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}
