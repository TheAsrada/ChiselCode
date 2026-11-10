import type { WorkspaceExtensionScope } from "../extensions/host.js";
import type { SecretRedactor } from "../security/redaction.js";
import type { ProjectSessionStore } from "../sessions/project-store.js";
import type { GlobalConfig, ProjectConfig, Session } from "../types/domain.js";
import type { BackgroundEvent } from "./contracts.js";
import type { ShellData } from "./input.js";

export interface BackgroundOwnerBinding {
  session: Session;
  store: ProjectSessionStore;
  root: string;
  origin?: string;
  conversationId: string;
  generation: number;
  signal: AbortSignal;
  assertAvailable(): void;
  scope: WorkspaceExtensionScope;
  config: ProjectConfig;
  global: GlobalConfig;
  configPath?: string;
  interactive: boolean;
  redactor: SecretRedactor;
  childId?: string;
  childLabel?: string;
  childDeadline?: number;
  worktree?: ShellData["worktree"];
  currentMode?(): string;
  onEvent?(event: BackgroundEvent): void;
}
