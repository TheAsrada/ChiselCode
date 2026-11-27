import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { userInstructionsDir } from "../paths/home.js";
import { admitWorkspace } from "../projects/admission.js";
import { builtinDefinitions } from "../providers/definitions/index.js";
import { CredentialStore } from "../security/credentials.js";
import { withLock } from "../sessions/lock.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { createSession, sessionTitleForPrompt } from "../sessions/store.js";
import { publishSkill } from "../skills/library.js";
import type { GlobalConfig } from "../types/domain.js";
import { replaceAtomicFile } from "../utils/atomic-file.js";
import {
  categoryIds,
  type ForeignSession,
  type MigrationActions,
  type MigrationCategory,
  type MigrationCounts,
  type MigrationResult,
  type MigrationSource,
  migrationCounts,
  sourceIds,
} from "./contracts.js";
import { file, missing } from "./files.js";
import { convertMcp } from "./mcp.js";
import {
  openCodeProvider,
  type SourceItems,
  skillPackage,
  sourceLocations,
  sourceReaders,
} from "./sources.js";

type Outcome = "imported" | "existing" | "skipped";
const digest = (...values: string[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

function profilePrefix(source: MigrationSource, integration: string) {
  return `import-${source}-${digest(integration).slice(0, 12)}-`;
}

async function importSession(
  source: MigrationSource,
  foreign: ForeignSession | undefined,
  profiles: GlobalConfig["profiles"],
  configPath?: string,
): Promise<Outcome> {
  if (!foreign || !isAbsolute(foreign.path)) return "skipped";
  const workspace = await admitWorkspace(foreign.path, {
    configPath,
    source: "resume",
  }).catch(() => undefined);
  if (!workspace) return "skipped";
  const integration =
    source === "claude"
      ? "anthropic"
      : source === "codex"
        ? (foreign.provider ?? "openai")
        : foreign.provider;
  const prefix = integration && profilePrefix(source, integration);
  const matchingProfiles = prefix
    ? Object.entries(profiles).filter(([id]) => id.startsWith(prefix))
    : [];
  const match = matchingProfiles.length === 1 ? matchingProfiles[0] : undefined;
  const provider =
    match?.[1].providerId ?? openCodeProvider(integration) ?? "openai";
  const model =
    foreign.model
      ?.trim()
      .replace(/\p{Cc}/gu, "")
      .slice(0, 1000) ||
    builtinDefinitions.find((definition) => definition.id === provider)
      ?.defaults.model ||
    "unknown";
  const session = createSession(workspace.root, provider, model);
  const key = digest(source, foreign.id);
  session.id = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
  if (match) session.profileId = match[0];
  session.messages = foreign.messages;
  const first = foreign.messages.find((message) => message.role === "user")
    ?.content[0];
  const title =
    foreign.title ||
    (first?.type === "text" ? sessionTitleForPrompt(first.text) : "");
  session.title =
    title
      .replace(/\p{Cc}/gu, " ")
      .trim()
      .slice(0, 160) || session.title;
  session.createdAt = foreign.created ?? session.createdAt;
  session.updatedAt = foreign.updated ?? session.createdAt;
  return (await (
    await projectSessionStore(workspace.root)
  ).insertImported(session))
    ? "imported"
    : "existing";
}

async function importInstructions(
  source: MigrationSource,
  path: string,
): Promise<Outcome> {
  const payload = await file(path, 256_000);
  if (!payload.toString("utf8").trim()) return "skipped";
  const directory = userInstructionsDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Недоступна папка инструкций.");
  const target = join(directory, `${source}.md`);
  return withLock(target, async (assertOwned) => {
    try {
      await lstat(target);
      return "existing";
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, payload, { mode: 0o600, flag: "wx" });
      await assertOwned();
      await replaceAtomicFile(staging, target);
    } finally {
      await rm(staging, { force: true });
    }
    return "imported";
  });
}

export function createMigrationActions(
  configPath?: string,
  env = process.env,
): MigrationActions {
  const locations = sourceLocations(env);
  const credentials = new CredentialStore();

  async function stageConfig(
    apply: (current: GlobalConfig) => Promise<GlobalConfig | undefined>,
  ): Promise<Outcome> {
    let outcome: Outcome = "existing";
    await updateGlobalConfig(configPath, async (current) => {
      if (current.mcpDiagnostics?.length)
        throw new Error("Исправьте повреждённые настройки MCP.");
      const next = await apply(current);
      if (next) outcome = "imported";
      return next ?? current;
    });
    return outcome;
  }

  const writers: {
    [K in MigrationCategory]: (
      source: MigrationSource,
      item: SourceItems[K],
      profiles: GlobalConfig["profiles"],
    ) => Promise<Outcome>;
  } = {
    sessions: async (source, item, profiles) =>
      importSession(source, await item.read(), profiles, configPath),
    instructions: importInstructions,
    skills: async (source, item) =>
      (await publishSkill(await skillPackage(item, source))).alreadyInstalled
        ? "existing"
        : "imported",
    mcp: async (source, item) => {
      const name = item.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .slice(0, 13);
      const id = `${source}-${name}-${digest(source, item.name).slice(0, 8)}`;
      const converted = convertMcp(item, source, id);
      if (!converted) return "skipped";
      return stageConfig(async (current) => {
        const servers = current.mcp?.servers ?? {};
        if (Object.hasOwn(servers, id)) return;
        if (Object.keys(servers).length >= 64)
          throw new Error("Достигнут лимит MCP.");
        for (const [ref, secret] of converted.secrets)
          await credentials.set(ref, secret);
        return {
          ...current,
          mcp: {
            schemaVersion: 1,
            servers: { ...servers, [id]: converted.server },
          },
        };
      });
    },
    connections: async (source, item) => {
      if (!item) return "skipped";
      const id = `${profilePrefix(source, item.integration)}${digest(item.id).slice(0, 12)}`;
      const apiKeyRef = `profile:${id}`;
      return stageConfig(async (current) => {
        if (Object.hasOwn(current.profiles, id)) return;
        await credentials.set(apiKeyRef, item.key);
        return {
          ...current,
          profiles: {
            ...current.profiles,
            [id]: { ...item.profile, apiKeyRef },
          },
        };
      });
    },
  };

  return {
    async inspect() {
      const results = await Promise.all(
        sourceIds.map(async (source) => {
          const counts = migrationCounts();
          const reads = await Promise.allSettled(
            categoryIds.map(async (category) => {
              counts[category] = (
                await sourceReaders[category](source, locations)
              ).length;
            }),
          );
          return {
            source,
            counts,
            unavailable: reads.some((read) => read.status === "rejected"),
          };
        }),
      );
      return {
        counts: Object.fromEntries(
          results.map(({ source, counts }) => [source, counts]),
        ) as Record<MigrationSource, MigrationCounts>,
        unavailable: results
          .filter((result) => result.unavailable)
          .map((result) => result.source),
      };
    },
    async run(selection) {
      const result: MigrationResult = {
        imported: migrationCounts(),
        existing: migrationCounts(),
        skipped: migrationCounts(),
        failed: migrationCounts(),
      };
      async function apply<K extends MigrationCategory>(
        source: MigrationSource,
        category: K,
      ) {
        let items: SourceItems[K][];
        let profiles: GlobalConfig["profiles"] = {};
        try {
          items = await sourceReaders[category](source, locations);
          if (category === "sessions" && items.length)
            profiles =
              (await loadGlobalConfig(configPath).catch(() => undefined))
                ?.profiles ?? {};
        } catch {
          result.failed[category]++;
          return;
        }
        for (const item of items) {
          try {
            const outcome = await writers[category](source, item, profiles);
            result[outcome][category]++;
          } catch {
            // Source parse errors and failed writes may contain credentials or paths.
            result.failed[category]++;
          }
        }
      }
      for (const source of sourceIds) {
        if (!selection.sources.includes(source)) continue;
        if (selection.categories.includes("connections"))
          await apply(source, "connections");
        for (const category of categoryIds)
          if (
            category !== "connections" &&
            selection.categories.includes(category)
          )
            await apply(source, category);
      }
      return result;
    },
  };
}
