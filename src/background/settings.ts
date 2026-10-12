import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { cancelled } from "../runtime/errors.js";
import {
  type BackgroundConfig,
  BackgroundConfigSchema,
  effectiveBackgroundConfig,
  type ProjectBackgroundConfig,
  ProjectBackgroundConfigSchema,
} from "./config.js";
export interface BackgroundSettingsState {
  workspaceRoot: string;
  global: BackgroundConfig;
  project: ProjectBackgroundConfig;
  effective: BackgroundConfig;
  globalRevision: string;
  projectRevision: string;
}
export interface BackgroundSettingsActions {
  load(signal?: AbortSignal): Promise<BackgroundSettingsState>;
  saveGlobal(
    config: BackgroundConfig,
    revision: string,
  ): Promise<BackgroundSettingsState>;
  saveProject(
    config: ProjectBackgroundConfig,
    revision: string,
  ): Promise<BackgroundSettingsState>;
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
export class BackgroundSettingsStore implements BackgroundSettingsActions {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly configPath: string | undefined,
    private readonly apply: () => Promise<void> = async () => {},
  ) {}
  async load(signal?: AbortSignal): Promise<BackgroundSettingsState> {
    cancelled(signal);
    const root = await canonicalWorkspaceRoot(this.root);
    const [global, text] = await Promise.all([
      loadGlobalConfig(this.configPath),
      source(root),
    ]);
    cancelled(signal);
    const project = ProjectBackgroundConfigSchema.parse(
      object(text).backgroundTasks ?? {},
    );
    const config = BackgroundConfigSchema.parse(global.backgroundTasks ?? {});
    return {
      workspaceRoot: root,
      global: config,
      project,
      effective: effectiveBackgroundConfig(config, project),
      globalRevision: hash(JSON.stringify(global.backgroundTasks ?? {})),
      projectRevision: hash(text),
    };
  }
  private write(work: () => Promise<void>): Promise<BackgroundSettingsState> {
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
    value: BackgroundConfig,
    revision: string,
  ): Promise<BackgroundSettingsState> {
    const config = BackgroundConfigSchema.parse(value);
    return this.write(async () => {
      await updateGlobalConfig(this.configPath, (current) => {
        if (hash(JSON.stringify(current.backgroundTasks ?? {})) !== revision)
          throw new Error(
            "Настройки фоновых задач изменились. Перезагрузите; введённые значения сохранены.",
          );
        return { ...current, backgroundTasks: config };
      });
    });
  }
  saveProject(
    value: ProjectBackgroundConfig,
    revision: string,
  ): Promise<BackgroundSettingsState> {
    const config = ProjectBackgroundConfigSchema.parse(value);
    return this.write(async () => {
      const root = await canonicalWorkspaceRoot(this.root);
      const text = await source(root);
      if (hash(text) !== revision)
        throw new Error(
          ".chiselrc изменён. Перезагрузите; введённые значения сохранены.",
        );
      const next = { ...object(text), backgroundTasks: config };
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
