import type { ProviderProfile } from "../providers/contracts.js";
import type { ChatMessage } from "../types/domain.js";

export const migrationSources = {
  claude: "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
} as const;
export type MigrationSource = keyof typeof migrationSources;
export const migrationCategories = {
  sessions: "История сессий",
  instructions: "Инструкции пользователя",
  skills: "Навыки",
  mcp: "MCP-серверы",
  connections: "Подключения и API-ключи",
} as const;
export type MigrationCategory = keyof typeof migrationCategories;
export const sourceIds = Object.keys(migrationSources) as MigrationSource[];
export const categoryIds = Object.keys(
  migrationCategories,
) as MigrationCategory[];

export type MigrationCounts = Record<MigrationCategory, number>;
export const migrationCounts = (): MigrationCounts => ({
  sessions: 0,
  instructions: 0,
  skills: 0,
  mcp: 0,
  connections: 0,
});

export interface MigrationSelection {
  sources: readonly MigrationSource[];
  categories: readonly MigrationCategory[];
}
export interface MigrationResult {
  imported: MigrationCounts;
  existing: MigrationCounts;
  skipped: MigrationCounts;
  failed: MigrationCounts;
}
export interface MigrationInventory {
  counts: Record<MigrationSource, MigrationCounts>;
  unavailable: MigrationSource[];
}
export interface MigrationActions {
  inspect(): Promise<MigrationInventory>;
  run(selection: MigrationSelection): Promise<MigrationResult>;
}

export interface ForeignSession {
  id: string;
  path: string;
  messages: ChatMessage[];
  model?: string;
  provider?: string;
  title?: string;
  created?: string;
  updated?: string;
}
export interface ForeignConnection {
  id: string;
  integration: string;
  profile: ProviderProfile;
  key: string;
}
