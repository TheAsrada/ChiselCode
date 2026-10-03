import type { Tool } from "@modelcontextprotocol/client";
import type { JsonObject } from "../types/domain.js";

export type McpConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "authentication_required"
  | "reconnecting"
  | "error"
  | "disabled";
export interface McpCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
  tasks: boolean;
}
export interface McpConnectionInfo {
  protocolVersion: string;
  serverName?: string;
  serverVersion?: string;
  capabilities: McpCapabilities;
}
export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}
export interface McpCallResult {
  content?: Array<{
    type: string;
    text?: string;
    resource?: { text?: string; uri?: string };
    uri?: string;
    mimeType?: string;
  }>;
  structuredContent?: McpJsonValue;
  isError?: boolean;
}
export type McpJsonValue =
  | null
  | string
  | number
  | boolean
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };
export interface McpConnection {
  initialize(signal?: AbortSignal): Promise<McpConnectionInfo>;
  listTools(signal?: AbortSignal): Promise<Tool[]>;
  callTool(
    name: string,
    input: JsonObject,
    signal?: AbortSignal,
    onProgress?: (progress: McpProgress) => void,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}
export interface McpConnectionCallbacks {
  closed(): void;
  error(error: unknown): void;
  stderr(text: string): void;
  toolsChanged(): void;
}
