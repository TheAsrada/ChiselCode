import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { cancelled } from "../runtime/errors.js";
import {
  effectiveSubagentConfig,
  type ProjectSubagentConfig,
  ProjectSubagentConfigSchema,
  type SubagentConfig,
  SubagentConfigSchema,
} from "./config.js";
export interface SubagentSettingsState {
  workspaceRoot: string;
  global: SubagentConfig;
  project: ProjectSubagentConfig;
  effective: SubagentConfig;
  globalRevision: string;
  projectRevision: string;
}
export interface SubagentSettingsActions {
  load(signal?: AbortSignal): Promise<SubagentSettingsState>;
  saveGlobal(
    config: SubagentConfig,
    revision: string,
  ): Promise<SubagentSettingsState>;
  saveProject(
    config: ProjectSubagentConfig,
    revision: string,
  ): Promise<SubagentSettingsState>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function source(root: string): Promise<string> {
  try {
    return await readFile(join(root, ".chiselrc"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
function object(text: string): Record<string, unknown> {
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Некорректный .chiselrc: файл не изменён.");
  return value;
}
/** Settings patches only their own typed fields; loading never starts an agent. */
export class SubagentSettingsStore implements SubagentSettingsActions {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly configPath: string | undefined,
    private readonly apply: () => Promise<void> = async () => {},
  ) {}
  async load(signal?: AbortSignal): Promise<SubagentSettingsState> {
    cancelled(signal);
    const root = await canonicalWorkspaceRoot(this.root);
    const [global, text] = await Promise.all([
      loadGlobalConfig(this.configPath),
      source(root),
    ]);
    cancelled(signal);
    const project = ProjectSubagentConfigSchema.parse(
      object(text).subagents ?? {},
    );
    const config = SubagentConfigSchema.parse(global.subagents ?? {});
    return {
      workspaceRoot: root,
      global: config,
      project,
      effective: effectiveSubagentConfig(config, project),
      globalRevision: hash(JSON.stringify(global.subagents ?? {})),
      projectRevision: hash(text),
    };
  }
  private write(work: () => Promise<void>): Promise<SubagentSettingsState> {
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        await work();
        await this.apply();
        return this.load();
      });
    this.pending = next;
    return next;
  }
  saveGlobal(
    value: SubagentConfig,
    revision: string,
  ): Promise<SubagentSettingsState> {
    const config = SubagentConfigSchema.parse(value);
    return this.write(async () => {
      await updateGlobalConfig(this.configPath, (current) => {
        if (hash(JSON.stringify(current.subagents ?? {})) !== revision)
          throw new Error(
            "Настройки помощников изменились. Перезагрузите; введённые значения сохранены.",
          );
        return { ...current, subagents: config };
      });
    });
  }
  saveProject(
    value: ProjectSubagentConfig,
    revision: string,
  ): Promise<SubagentSettingsState> {
    const config = ProjectSubagentConfigSchema.parse(value);
    return this.write(async () => {
      const root = await canonicalWorkspaceRoot(this.root);
      const text = await source(root);
      if (hash(text) !== revision)
        throw new Error(
          ".chiselrc изменён. Перезагрузите; введённые значения сохранены.",
        );
      const next = { ...object(text), subagents: config };
      const temporary = join(root, `.chiselrc.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        if ((await source(root)) !== text)
          throw new Error(
            ".chiselrc изменён во время сохранения; запись отменена.",
          );
        await rename(temporary, join(root, ".chiselrc"));
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
}
