import type {
  ExtensionCommandDescriptor,
  ExtensionCommandIdentity,
} from "../extensions/contracts.js";
import { SecretRedactor } from "../security/redaction.js";

export const SLASH_COMMANDS = [
  {
    name: "/clear",
    description: "начать новую вкладку, сохранив текущий разговор",
  },
  { name: "/cwd", description: "сменить папку проекта: <путь>" },
  {
    name: "/settings",
    description: "подключение, оформление и разрешения",
  },
  { name: "/model", description: "сменить модель" },
  { name: "/skills", description: "скиллы: выбрать и задействовать" },
  { name: "/status", description: "показать состояние сессии" },
  { name: "/sessions", description: "выбрать сеанс проекта" },
  { name: "/resume", description: "открыть выбор сеанса" },
  { name: "/update", description: "проверить и установить обновление" },
  { name: "/doctor", description: "проверить настройку без показа ключей" },
  { name: "/home", description: "перейти на главную" },
  { name: "/new", description: "создать вкладку сессии" },
  { name: "/exit", description: "закрыть ChiselCode" },
  { name: "/plan", description: "Plan: изучить проект и составить план" },
  { name: "/build", description: "Build: выполнить изменения" },
  { name: "/mode", description: "сменить режим: plan|build" },
  {
    name: "/permissions",
    description: "выбрать Manual, Accept edits, Dont ask или Bypass",
  },
  { name: "/ask", description: "Manual: подтверждать изменения и команды" },
  {
    name: "/auto",
    description: "Accept edits: разрешать правки файлов проекта",
  },
  { name: "/mcp", description: "Подключения MCP, инструменты и разрешения" },
  {
    name: "/sidebar",
    description: "показать или скрыть контекст: auto|show|hide",
  },
] as const;

export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  SLASH_COMMANDS.map((command) => command.name),
);
export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"];
export interface CommandSuggestion {
  name: string;
  description: string;
}
export type CommandSource =
  | { readonly type: "builtin" }
  | { readonly type: "skill"; readonly name: string }
  | ExtensionCommandIdentity;
export interface CommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly source: CommandSource;
  readonly executionPolicy?: "foreground" | "side_query";
  readonly controlActions?: readonly string[];
}
export interface CommandProjection {
  readonly commands: readonly CommandDescriptor[];
}
export interface ParsedSlashCommand {
  name: string;
  args: string;
}

/** No shell expansion; case-sensitive identity, unchanged inner argument text. */
export function splitSlashCommand(
  input: string,
): ParsedSlashCommand | undefined {
  const value = input.trim();
  if (!value.startsWith("/")) return undefined;
  const space = value.search(/\s/);
  return {
    name: space === -1 ? value : value.slice(0, space),
    args: space === -1 ? "" : value.slice(space).trim(),
  };
}
export function resolveSlashCommand(
  projection: CommandProjection,
  input: string,
): CommandDescriptor | undefined {
  const parsed = splitSlashCommand(input);
  return projection.commands.find((command) => command.name === parsed?.name);
}

export class CommandConflictError extends Error {
  constructor(
    readonly extensionId: string,
    name: string,
    prior: CommandSource,
  ) {
    super(
      `Command ${name} from extension ${extensionId} conflicts with ${prior.type === "extension" ? `extension ${prior.extensionId}` : prior.type === "skill" ? `skill /${prior.name}` : "a built-in command"}.`,
    );
    this.name = "CommandConflictError";
  }
}
const redactor = new SecretRedactor();
/** Validate the entire extension layer before publishing any of it. */
export function composeCommandProjection(
  skills: readonly CommandSuggestion[] = [],
  extensions: readonly ExtensionCommandDescriptor[] = [],
): CommandProjection {
  const commands: CommandDescriptor[] = SLASH_COMMANDS.map((command) => ({
    ...command,
    source: { type: "builtin" },
  }));
  const byName = new Map(commands.map((command) => [command.name, command]));
  for (const skill of skills) {
    const name = `/${skill.name.replace(/^\//, "")}`;
    if (byName.has(name)) continue; // Existing built-in/skill precedence is unchanged.
    const descriptor: CommandDescriptor = {
      name,
      description: redactor.text(skill.description),
      source: { type: "skill", name: skill.name.replace(/^\//, "") },
    };
    commands.push(descriptor);
    byName.set(name, descriptor);
  }
  for (const contribution of extensions) {
    const name = `/${contribution.name}`;
    const prior = byName.get(name);
    if (prior)
      throw new CommandConflictError(
        contribution.source.extensionId,
        name,
        prior.source,
      );
    const descriptor: CommandDescriptor = {
      name,
      description: redactor.text(contribution.description),
      ...(contribution.usage
        ? { usage: redactor.text(contribution.usage) }
        : {}),
      source: { ...contribution.source },
      executionPolicy: contribution.executionPolicy ?? "foreground",
      ...(contribution.controlActions
        ? { controlActions: Object.freeze([...contribution.controlActions]) }
        : {}),
    };
    commands.push(descriptor);
    byName.set(name, descriptor);
  }
  return Object.freeze({
    commands: Object.freeze(
      commands.map((command) =>
        Object.freeze({ ...command, source: Object.freeze(command.source) }),
      ),
    ),
  });
}
export function parseSlashCommand(
  input: string,
  projection = composeCommandProjection(),
): ParsedSlashCommand | undefined {
  return resolveSlashCommand(projection, input)
    ? splitSlashCommand(input)
    : undefined;
}
