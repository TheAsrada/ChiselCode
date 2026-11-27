import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { builtinDefinitions } from "../providers/definitions/index.js";
import { openai } from "../providers/definitions/openai.js";
import { resolveEndpoint } from "../providers/endpoint.js";
import {
  SKILL_PACKAGE_LIMITS,
  validateSkillPackage,
} from "../skills/package.js";
import {
  type ForeignConnection,
  type ForeignSession,
  type MigrationCategory,
  type MigrationSource,
  migrationSources,
} from "./contracts.js";
import {
  entries,
  file,
  filesUnder,
  json,
  missing,
  packagePath,
  record,
  string,
} from "./files.js";
import { openCodeCredentials, openCodeSessions } from "./opencode.js";
import { readJsonlSession } from "./transcripts.js";

export type ForeignMcp = { name: string; config: unknown };
export type SourceItems = {
  sessions: { read(): Promise<ForeignSession | undefined> };
  instructions: string;
  skills: string;
  mcp: ForeignMcp;
  connections: ForeignConnection | undefined;
};

export function sourceLocations(env: NodeJS.ProcessEnv) {
  const home =
    (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const configBase = env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    home,
    claude: resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude")),
    codex: resolve(env.CODEX_HOME || join(home, ".codex")),
    openConfig: resolve(
      env.OPENCODE_CONFIG_DIR || join(configBase, "opencode"),
    ),
    openFile: env.OPENCODE_CONFIG ? resolve(env.OPENCODE_CONFIG) : undefined,
    openData: resolve(
      env.XDG_DATA_HOME || join(home, ".local", "share"),
      "opencode",
    ),
  };
}

type Locations = ReturnType<typeof sourceLocations>;

async function codexConfig(root: string) {
  try {
    return record(
      Bun.TOML.parse(await file(join(root, "config.toml"), 2 * 1024 * 1024)),
    );
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
}

async function openCodeConfig(locations: Locations) {
  const { openConfig, openFile } = locations;
  const configs: Record<string, unknown>[] = await Promise.all([
    json(join(openConfig, "opencode.json")),
    json(join(openConfig, "opencode.jsonc")),
    openFile ? json(openFile) : {},
  ]);
  return {
    mcp: Object.assign(
      Object.create(null),
      ...configs.map((config) => record(config.mcp)),
    ) as Record<string, unknown>,
    providers: Object.assign(
      Object.create(null),
      ...configs.map((config) => record(config.provider)),
    ) as Record<string, unknown>,
    model: configs.reduce<string | undefined>(
      (model, config) => string(config.model) ?? model,
      undefined,
    ),
  };
}

const modelId = (value: unknown) => {
  const model = string(value)?.trim();
  return model && model.length <= 1000 && !/\p{Cc}/u.test(model)
    ? model
    : undefined;
};

function connection(
  source: MigrationSource,
  id: string,
  provider: string,
  key: unknown,
  endpoint?: string,
  model?: unknown,
  integration = provider,
): ForeignConnection | undefined {
  const cleanKey = string(key)?.trim();
  const definition = builtinDefinitions.find((item) => item.id === provider);
  if (
    !cleanKey ||
    cleanKey.length > 4096 ||
    /\p{Cc}|\{(?:env|file):/u.test(cleanKey) ||
    !definition
  )
    return;
  try {
    const baseUrl = resolveEndpoint(definition, endpoint);
    return {
      id,
      integration,
      key: cleanKey,
      profile: {
        providerId: provider,
        label: `${migrationSources[source]} · ${/^[a-zA-Z0-9._-]{1,48}$/.test(integration) ? integration : definition.label}`,
        ...(baseUrl && { baseUrl }),
        defaultModel: modelId(model) ?? definition.defaults.model,
      },
    };
  } catch {
    return undefined;
  }
}

export function openCodeProvider(id: string | undefined) {
  if (id === "anthropic" || id === "openai" || id === "agentrouter") return id;
  if (id === "openrouter") return "openai-compatible";
  return undefined;
}

async function connections(source: MigrationSource, locations: Locations) {
  if (source === "claude") {
    const { claude, home } = locations;
    const [settings, state, sharedState] = await Promise.all([
      json(join(claude, "settings.json")),
      json(join(claude, ".claude.json")),
      json(join(home, ".claude.json")),
    ]);
    const env = record(settings.env);
    const key =
      string(env.ANTHROPIC_API_KEY) ??
      string(state.primaryApiKey) ??
      string(sharedState.primaryApiKey);
    return key
      ? [
          connection(
            source,
            "anthropic",
            "anthropic",
            key,
            string(env.ANTHROPIC_BASE_URL),
            settings.model,
          ),
        ]
      : [];
  }
  if (source === "codex") {
    const [auth, settings] = await Promise.all([
      json(join(locations.codex, "auth.json")),
      codexConfig(locations.codex),
    ]);
    return string(auth.OPENAI_API_KEY)
      ? [
          connection(
            source,
            openai.id,
            openai.id,
            auth.OPENAI_API_KEY,
            undefined,
            !settings.model_provider || settings.model_provider === openai.id
              ? settings.model
              : undefined,
          ),
        ]
      : [];
  }
  const [config, legacy, database] = await Promise.all([
    openCodeConfig(locations),
    json(join(locations.openData, "auth.json")),
    openCodeCredentials(locations.openData),
  ]);
  const keys = database.filter((item) => !!item.key);
  const present = new Set(keys.map((item) => item.provider));
  for (const [provider, raw] of Object.entries(legacy)) {
    const entry = record(raw);
    const key = string(entry.key);
    if (entry.type === "api" && key && !present.has(provider)) {
      keys.push({ id: provider, provider, key });
      present.add(provider);
    }
  }
  for (const [provider, raw] of Object.entries(config.providers)) {
    const key = string(record(record(raw).options).apiKey);
    if (key && !present.has(provider))
      keys.push({ id: provider, provider, key });
  }
  return keys.map(({ id, provider, key }) => {
    const definition = record(config.providers[provider]);
    const mapped =
      openCodeProvider(provider) ??
      (definition.npm === "@ai-sdk/openai-compatible"
        ? "openai-compatible"
        : undefined);
    const endpoint =
      string(record(definition.options).baseURL) ??
      (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined);
    const [modelProvider, ...model] = (config.model ?? "").split("/");
    return mapped
      ? connection(
          source,
          id,
          mapped,
          key,
          endpoint,
          provider === modelProvider ? model.join("/") : undefined,
          provider,
        )
      : undefined;
  });
}

export const sourceReaders: {
  [K in MigrationCategory]: (
    source: MigrationSource,
    locations: Locations,
  ) => Promise<SourceItems[K][]>;
} = {
  async sessions(source, locations) {
    if (source === "opencode") return openCodeSessions(locations.openData);
    const folders =
      source === "claude" ? ["projects"] : ["sessions", "archived_sessions"];
    const paths = (
      await Promise.all(
        folders.map((folder) =>
          filesUnder(
            join(locations[source], folder),
            (name) => name.endsWith(".jsonl"),
            source === "claude" ? 1 : 4,
          ),
        ),
      )
    ).flat();
    return paths.map((path) => ({
      read: () => readJsonlSession(path, source),
    }));
  },
  async instructions(source, locations) {
    const root =
      source === "opencode" ? locations.openConfig : locations[source];
    const names =
      source === "claude"
        ? ["CLAUDE.md"]
        : source === "codex"
          ? ["AGENTS.override.md", "AGENTS.md"]
          : ["AGENTS.md"];
    for (const name of names) {
      const path = join(root, name);
      try {
        if ((await lstat(path)).isFile()) return [path];
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return [];
  },
  async skills(source, locations) {
    const root =
      source === "opencode" ? locations.openConfig : locations[source];
    const directories = [join(root, "skills")];
    if (source === "opencode") directories.push(join(root, "skill"));
    if (source !== "claude")
      directories.push(join(locations.home, ".agents", "skills"));
    const paths = await Promise.all(
      [...new Set(directories)].map(async (base) => {
        const children = await entries(base);
        const found: string[] = [];
        for (const child of children) {
          if (!child.isDirectory() || child.name.startsWith(".")) continue;
          const path = join(base, child.name);
          if (
            (await entries(path)).some(
              (entry) => entry.isFile() && entry.name === "SKILL.md",
            )
          )
            found.push(path);
        }
        return found.sort();
      }),
    );
    return paths.flat();
  },
  async mcp(source, locations) {
    let configs: Record<string, unknown>;
    if (source === "codex")
      configs = record((await codexConfig(locations.codex)).mcp_servers);
    else if (source === "opencode")
      configs = (await openCodeConfig(locations)).mcp;
    else {
      const [shared, local] = await Promise.all([
        json(join(locations.home, ".claude.json")),
        json(join(locations.claude, ".claude.json")),
      ]);
      configs = { ...record(shared.mcpServers), ...record(local.mcpServers) };
    }
    return Object.entries(configs).map(([name, config]) => ({ name, config }));
  },
  connections,
};

export async function skillPackage(path: string, source: MigrationSource) {
  const paths = await filesUnder(
    path,
    (name) => name !== ".chisel-source.json",
    12,
    512,
  );
  if (paths.length > SKILL_PACKAGE_LIMITS.files)
    throw new Error("Слишком много файлов навыка.");
  let total = 0;
  const files = new Map<string, Uint8Array>();
  for (const item of paths) {
    const bytes = await file(item, SKILL_PACKAGE_LIMITS.fileBytes);
    total += bytes.length;
    if (total > SKILL_PACKAGE_LIMITS.bytes)
      throw new Error("Пакет навыка слишком большой.");
    files.set(packagePath(path, item), bytes);
  }
  return validateSkillPackage(files, basename(path), {
    url: `migration:${source}`,
    path: basename(path),
  });
}
