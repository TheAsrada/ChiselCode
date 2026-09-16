import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { GlobalConfig, ProjectConfig } from "../types/domain.js";
import { ProviderKindSchema } from "../types/domain.js";

const ProjectConfigSchema = z.object({
  allowedCommands: z.array(z.string()).default([]),
  deniedCommands: z.array(z.string()).default([]),
  ignorePatterns: z
    .array(z.string())
    .default([".git/**", "node_modules/**", ".chisel/**"]),
  autoApprove: z.boolean().default(false),
});

const GlobalConfigSchema = z.object({
  defaultProvider: ProviderKindSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  providers: z
    .object({
      anthropic: z
        .object({
          provider: z.literal("anthropic"),
          apiKeyRef: z.string().optional(),
          defaultModel: z.string().optional(),
        })
        .optional(),
      "anthropic-compatible": z
        .object({
          provider: z.literal("anthropic-compatible"),
          apiKeyRef: z.string().optional(),
          baseUrl: z.string().url().optional(),
          defaultModel: z.string().optional(),
        })
        .optional(),
      openai: z
        .object({
          provider: z.literal("openai"),
          apiKeyRef: z.string().optional(),
          defaultModel: z.string().optional(),
        })
        .optional(),
      "openai-compatible": z
        .object({
          provider: z.literal("openai-compatible"),
          apiKeyRef: z.string().optional(),
          baseUrl: z.string().url().optional(),
          defaultModel: z.string().optional(),
        })
        .optional(),
      agentrouter: z
        .object({
          provider: z.literal("agentrouter"),
          apiKeyRef: z.string().optional(),
          baseUrl: z.string().url().optional(),
          defaultModel: z.string().optional(),
        })
        .optional(),
    })
    .default({}),
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
  } catch (error) {
    throw new Error(
      `Invalid .chiselrc JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return ProjectConfigSchema.parse(raw);
}

export async function loadProjectInstructions(
  projectRoot: string,
): Promise<string> {
  return (await readOptional(join(projectRoot, "CHISEL.md")))?.trim() ?? "";
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
  if (!source) return { providers: {} };
  return GlobalConfigSchema.parse(JSON.parse(source));
}

export async function saveGlobalConfig(
  config: GlobalConfig,
  path = globalConfigPath(),
): Promise<void> {
  const validated = GlobalConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
