import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { InstructionResolver } from "../context/instructions.js";
import { readMcpConfig } from "../mcp/configuration.js";
import { McpConfigSchema } from "../mcp/schema.js";
import type { GlobalConfig, ProjectConfig } from "../types/domain.js";
import { ProjectWebConfigSchema } from "../web/schema.js";
import {
  migrateConfig,
  normalizeConfigForSave,
  withLegacyAccessors,
} from "./migrate.js";

const ProjectConfigSchema = z.object({
  web: ProjectWebConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  context: z
    .object({
      autoCompact: z.boolean().optional(),
      bufferRatio: z.number().min(0).max(0.5).optional(),
      keepRecentTokens: z.number().int().nonnegative().optional(),
      maxInlineToolResultTokens: z.number().int().min(128).optional(),
      contextWindow: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
  tools: z
    .object({ maxParallelReads: z.number().int().min(1).max(16).optional() })
    .optional(),
  editing: z.object({ requireFreshRead: z.boolean().optional() }).optional(),
  allowedCommands: z.array(z.string()).default([]),
  deniedCommands: z.array(z.string()).default([]),
  ignorePatterns: z
    .array(z.string())
    .default([".git/**", "node_modules/**", ".chisel/**"]),
  autoApprove: z.boolean().default(false),
});

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedCommands: [],
  deniedCommands: [],
  ignorePatterns: [".git/**", "node_modules/**", ".chisel/**"],
  autoApprove: false,
};

export async function loadProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const source = await readOptional(join(projectRoot, ".chiselrc"));
  if (!source) return DEFAULT_PROJECT_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("Invalid .chiselrc JSON; original file was not changed.");
  }
  const mcp = readMcpConfig((raw as { mcp?: unknown }).mcp);
  const config = ProjectConfigSchema.parse({
    ...(raw as Record<string, unknown>),
    mcp: mcp.config,
  });
  Object.defineProperty(config, "mcpDiagnostics", {
    value: mcp.diagnostics,
    enumerable: false,
  });
  return config;
}

export async function loadProjectInstructions(
  projectRoot: string,
): Promise<string> {
  return new InstructionResolver().resolve(projectRoot);
}

export function globalConfigPath(): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ??
        join(process.env.USERPROFILE ?? process.cwd(), ".config"))
      : (process.env.XDG_CONFIG_HOME ??
        join(process.env.HOME ?? process.cwd(), ".config"));
  return join(base, "chiselcode", "config.json");
}

export async function loadGlobalConfig(
  path = globalConfigPath(),
): Promise<GlobalConfig> {
  const source = await readOptional(path);
  try {
    const raw = source ? JSON.parse(source) : { providers: {} };
    const mcp = readMcpConfig(raw.mcp);
    const config = withLegacyAccessors(
      migrateConfig({ ...raw, mcp: mcp.config }),
    );
    Object.defineProperty(config, "mcpDiagnostics", {
      value: mcp.diagnostics,
      enumerable: false,
    });
    return config;
  } catch {
    throw new Error(
      `Invalid ChiselCode config at ${path}; original file was not changed.`,
    );
  }
}

export async function saveGlobalConfig(
  config: unknown,
  path = globalConfigPath(),
): Promise<void> {
  let validated: ReturnType<typeof normalizeConfigForSave>;
  try {
    validated = normalizeConfigForSave(config);
  } catch {
    throw new Error(
      `Invalid ChiselCode config at ${path}; original file was not changed.`,
    );
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const original = await readOptional(path);
  if (original) {
    let raw: unknown;
    try {
      raw = JSON.parse(original);
      migrateConfig(raw);
    } catch {
      throw new Error(
        `Invalid ChiselCode config at ${path}; original file was not changed.`,
      );
    }
    if ((raw as { schemaVersion?: number }).schemaVersion !== 2) {
      const backup = join(dirname(path), "config.v1.backup.json");
      try {
        const handle = await open(backup, "wx", 0o600);
        try {
          await handle.writeFile(original, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
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

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
