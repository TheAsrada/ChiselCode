import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { sessionProjectsDir, sessionsRootDir } from "../paths/home.js";
import { ProviderKindSchema, type Session } from "../types/domain.js";

const idSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const timestamp = z.iso.datetime({ offset: true });
const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
});
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
const persistedSessionSchema = z.object({
  schemaVersion: z.literal(2),
  id: idSchema,
  title: z.string(),
  titleSource: z.enum(["auto", "user"]),
  createdAt: timestamp,
  updatedAt: timestamp,
  provider: ProviderKindSchema,
  model: z.string(),
  gitBranch: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.array(contentSchema),
    }),
  ),
  totalTokens: usageSchema,
  totalCost: z.number(),
  undoStack: z.array(
    z.object({
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  fileDiffs: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        kind: z.enum(["create", "edit", "delete"]),
        patch: z.string(),
        additions: z.number(),
        deletions: z.number(),
      }),
    )
    .optional(),
});
const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  name: z.string(),
  path: z.string(),
  canonicalPath: z.string(),
  createdAt: timestamp,
  lastOpenedAt: timestamp,
  git: z
    .object({ remote: z.string().optional(), branch: z.string().optional() })
    .optional(),
});
const registrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(projectSchema),
});
const summarySchema = z.object({
  id: idSchema,
  title: z.string(),
  titleSource: z.enum(["auto", "user"]),
  createdAt: timestamp,
  updatedAt: timestamp,
  provider: ProviderKindSchema,
  model: z.string(),
  gitBranch: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  totalTokens: usageSchema,
  lastUserMessage: z.string().optional(),
});
const indexSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(summarySchema),
});

export type SessionSummary = z.infer<typeof summarySchema>;
export type ProjectMetadata = z.infer<typeof projectSchema>;

export function assertSessionId(id: string): string {
  return idSchema.parse(id);
}
const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 99) throw new Error(`Хранилище занято: ${path}`);
      await new Promise((done) => setTimeout(done, 30 + Math.random() * 20));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
async function canonicalize(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch {
    canonical = resolve(path);
  }
  return process.platform === "win32"
    ? canonical.replaceAll("/", "\\").toLowerCase()
    : canonical;
}
async function listFiles(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
async function recoverProjects(): Promise<ProjectMetadata[]> {
  const projects: ProjectMetadata[] = [];
  for (const id of await listFiles(sessionProjectsDir())) {
    if (!idSchema.safeParse(id).success) continue;
    try {
      const project = projectSchema.parse(
        await readJson(join(sessionProjectsDir(), id, "project.json")),
      );
      if (project.id === id) projects.push(project);
    } catch {
      /* damaged metadata is isolated */
    }
  }
  return projects;
}
export class SessionProjectRegistry {
  async list(): Promise<ProjectMetadata[]> {
    try {
      return registrySchema.parse(
        await readJson(join(sessionsRootDir(), "projects.json")),
      ).projects;
    } catch {
      const projects = await recoverProjects();
      await mkdir(sessionsRootDir(), { recursive: true });
      await atomicJson(join(sessionsRootDir(), "projects.json"), {
        schemaVersion: 1,
        projects,
      });
      return projects;
    }
  }
  async forPath(path: string): Promise<ProjectSessionStore> {
    await mkdir(sessionProjectsDir(), { recursive: true });
    const canonicalPath = await canonicalize(path);
    const registryPath = join(sessionsRootDir(), "projects.json");
    const project = await withLock(registryPath, async () => {
      const projects = await this.list();
      const now = new Date().toISOString();
      let item = projects.find(
        (entry) => entry.canonicalPath === canonicalPath,
      );
      if (!item) {
        item = {
          schemaVersion: 1,
          id: randomUUID(),
          name: basename(resolve(path)),
          path: resolve(path),
          canonicalPath,
          createdAt: now,
          lastOpenedAt: now,
        };
        projects.push(item);
      } else item.lastOpenedAt = now;
      const directory = join(sessionProjectsDir(), item.id);
      await mkdir(directory, { recursive: true });
      await atomicJson(join(directory, "project.json"), item);
      await atomicJson(registryPath, { schemaVersion: 1, projects });
      return item;
    });
    const store = new ProjectSessionStore(project);
    await store.migrateLegacy();
    return store;
  }
}

function toSummary(session: Session): SessionSummary {
  const last = [...session.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        message.content.some((item) => item.type === "text"),
    );
  return {
    id: session.id,
    title: session.title ?? "Без названия",
    titleSource: session.titleSource ?? "auto",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    provider: session.provider,
    model: session.model,
    gitBranch: session.gitBranch,
    messageCount: session.messages.length,
    totalTokens: session.totalTokens,
    lastUserMessage: last?.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ")
      .slice(0, 300),
  };
}
export class ProjectSessionStore {
  readonly projectId: string;
  readonly directory: string;
  constructor(readonly project: ProjectMetadata) {
    this.projectId = project.id;
    this.directory = join(sessionProjectsDir(), project.id);
  }
  private file(id: string): string {
    return join(this.directory, `${assertSessionId(id)}.json`);
  }
  private get indexPath(): string {
    return join(this.directory, "index.json");
  }
  create(provider: Session["provider"], model: string): Session {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      projectPath: this.project.path,
      messages: [],
      provider,
      model,
      title: "Без названия",
      titleSource: "auto",
      totalTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      totalCost: 0,
      undoStack: [],
      createdAt: now,
      updatedAt: now,
    };
  }
  async save(session: Session): Promise<void> {
    assertSessionId(session.id);
    session.updatedAt = new Date().toISOString();
    if (!session.titleSource) session.titleSource = "auto";
    await mkdir(this.directory, { recursive: true });
    const { projectPath: _projectPath, ...fields } = session;
    const persisted = persistedSessionSchema.parse({
      ...fields,
      schemaVersion: 2,
      title: session.title || "Без названия",
    });
    await atomicJson(this.file(session.id), persisted);
    await withLock(this.indexPath, async () => {
      let index: z.infer<typeof indexSchema>;
      try {
        index = indexSchema.parse(await readJson(this.indexPath));
      } catch {
        index = { schemaVersion: 1, sessions: [] };
      }
      index.sessions = [
        toSummary(session),
        ...index.sessions.filter((entry) => entry.id !== session.id),
      ];
      await atomicJson(this.indexPath, index);
    });
  }
  async load(id: string): Promise<Session> {
    const raw = await readJson(this.file(id));
    const parsed = persistedSessionSchema.parse(raw);
    if (parsed.id !== id)
      throw new Error(`ID сессии не совпадает с именем файла: ${id}`);
    return { ...parsed, projectPath: this.project.path } as Session;
  }
  async list(): Promise<SessionSummary[]> {
    let index: z.infer<typeof indexSchema>;
    try {
      index = indexSchema.parse(await readJson(this.indexPath));
    } catch {
      return this.rebuildIndex();
    }
    const files = (await listFiles(this.directory)).filter(
      (name) =>
        name.endsWith(".json") && idSchema.safeParse(name.slice(0, -5)).success,
    );
    const ids = new Set(files.map((name) => name.slice(0, -5)));
    if (
      ids.size !== index.sessions.length ||
      index.sessions.some((entry) => !ids.has(entry.id))
    )
      return this.rebuildIndex();
    // Metadata-only stat detects a session file written before a crashed index update.
    const indexStat = await stat(this.indexPath);
    for (const name of files)
      if (
        (await stat(join(this.directory, name))).mtimeMs >
        indexStat.mtimeMs + 2
      )
        return this.rebuildIndex();
    return index.sessions.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async getSummary(id: string): Promise<SessionSummary | undefined> {
    return (await this.list()).find((item) => item.id === assertSessionId(id));
  }
  async rebuildIndex(): Promise<SessionSummary[]> {
    return withLock(this.indexPath, async () => {
      const sessions: SessionSummary[] = [];
      for (const name of await listFiles(this.directory)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (!idSchema.safeParse(id).success) continue;
        try {
          sessions.push(toSummary(await this.load(id)));
        } catch {
          /* corrupt session remains on disk */
        }
      }
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      await atomicJson(this.indexPath, { schemaVersion: 1, sessions });
      return sessions;
    });
  }
  async rename(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Название сессии не может быть пустым.");
    const session = await this.load(id);
    session.title = trimmed.slice(0, 120);
    session.titleSource = "user";
    await this.save(session);
  }
  async delete(id: string): Promise<void> {
    await rm(this.file(id));
    await withLock(this.indexPath, async () => {
      let index: z.infer<typeof indexSchema>;
      try {
        index = indexSchema.parse(await readJson(this.indexPath));
      } catch {
        index = { schemaVersion: 1, sessions: [] };
      }
      index.sessions = index.sessions.filter((entry) => entry.id !== id);
      await atomicJson(this.indexPath, index);
    });
  }
  async resolve(ref: string): Promise<SessionSummary> {
    const value = ref.trim().toLowerCase();
    if (!value || /[\\/%:]|\.\./.test(value))
      throw new Error("Некорректный ID сессии.");
    const matches = (await this.list()).filter((item) =>
      item.id.toLowerCase().startsWith(value),
    );
    if (matches.length === 0)
      throw new Error(`Сессия «${ref}» не найдена в текущем проекте.`);
    if (matches.length > 1)
      throw new Error(
        `Префикс «${ref}» неоднозначен: ${matches.length} сессий.`,
      );
    const found = matches[0];
    if (!found) throw new Error(`Сессия «${ref}» не найдена.`);
    return found;
  }
  async migrateLegacy(): Promise<void> {
    const marker = join(this.directory, ".legacy-v2-migrated");
    try {
      await stat(marker);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const oldRoot =
      process.platform === "win32"
        ? join(process.env.APPDATA ?? "", "chiselcode", "sessions")
        : join(
            process.env.XDG_CONFIG_HOME ??
              join(process.env.HOME ?? "", ".config"),
            "chiselcode",
            "sessions",
          );
    for (const sourceRoot of [oldRoot, sessionsRootDir()]) {
      for (const name of await listFiles(sourceRoot)) {
        if (
          !name.endsWith(".json") ||
          !idSchema.safeParse(name.slice(0, -5)).success
        )
          continue;
        const source = join(sourceRoot, name);
        let legacy: Session | undefined;
        try {
          legacy = (await readJson(source)) as Session;
        } catch {
          /* malformed legacy data remains untouched */
        }
        if (
          !legacy ||
          legacy.id !== name.slice(0, -5) ||
          !legacy.projectPath ||
          !Array.isArray(legacy.messages)
        )
          continue;
        if (
          (await canonicalize(legacy.projectPath)) !==
          this.project.canonicalPath
        )
          continue;
        try {
          await stat(this.file(legacy.id));
          continue;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        try {
          await this.save({
            ...legacy,
            titleSource: legacy.titleSource ?? "auto",
          });
        } catch {}
      }
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(marker, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    try {
      await handle.writeFile("Legacy originals retained.\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function projectSessionStore(
  path: string,
): Promise<ProjectSessionStore> {
  return new SessionProjectRegistry().forPath(path);
}
