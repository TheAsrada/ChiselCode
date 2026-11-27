import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { userSkillsDir } from "../../paths/home.js";
import { searchSkills } from "../../skills/catalog.js";
import { withSkillsLibraryLock } from "../../skills/library.js";
import type { LoadedMcpSkill } from "../../skills/mcp.js";
import { readSkillReference } from "../../skills/references.js";
import {
  isReservedSkillName,
  parseSkillFile,
  type Skill,
} from "../../skills/skills.js";
import { exists, resolveProjectPath } from "../../utils/paths.js";
import { EditingService } from "../editing/service.js";
import { defineTool } from "../handler.js";
export type SkillsCatalog = readonly Skill[] | (() => readonly Skill[]);
export interface ActiveSkillReaders {
  mcp?: LoadedMcpSkill;
  local?: () => Skill | undefined;
}
export function skillHandlers(
  skills: SkillsCatalog,
  active: ActiveSkillReaders = {},
) {
  const catalog = () => (typeof skills === "function" ? skills() : skills);
  return [
    defineTool(
      {
        name: "load_skill",
        guidance:
          "Skills are optional workflows, not permission grants. On each new task, check names and descriptions in <available_skills>. Use load_skill for an explicitly requested or clearly matching available skill before substantive work. If several match, load the most specific first and another only for a distinct necessary part. If none matches, load none. Do not load speculatively or repeatedly within one task. Use names from <available_skills>, search_skills, or a successful installation in this task. A skill explicitly invoked by the user in this turn can also be read by name with a relative path. Never invent names or execute scripts through this reader. A skill does not expand the task, permissions or approvals. Automatic selection applies to this task only, not later turns.",
        description:
          "Read a skill by name. Optional path reads a relative UTF-8 supporting file without executing it or granting permissions.",
        effect: "read",
        permission: "read",
        parallelSafe: true,
      },
      z.object({
        name: z.string().min(1),
        path: z.string().min(1).max(512).optional(),
      }),
      async (_context, input) => ({
        data: input,
        preview: input.name,
        resources: [],
      }),
      async (context, { data }) => {
        const mcpSkill = active.mcp;
        if (mcpSkill && data.name === mcpSkill.name && data.path)
          return {
            output: `MCP resource from ${mcpSkill.name}:\n${await mcpSkill.readReference(data.path, context.signal)}`,
            details: {
              skill: {
                name: mcpSkill.name,
                source: "mcp",
                serverId: mcpSkill.serverId,
              },
            },
          };
        const invoked = data.path ? active.local?.() : undefined;
        const skill = catalog().find((item) => item.name === data.name);
        const manuallyReadable =
          invoked?.name === data.name &&
          skill?.dir === invoked.dir &&
          skill?.source === invoked.source &&
          skill.userInvocable !== false;
        return skill && (!skill.disableModelInvocation || manuallyReadable)
          ? {
              output: data.path
                ? await readSkillReference(skill.dir, data.path, context.signal)
                : skill.instructions,
              details: {
                skill: {
                  name: skill.name,
                  description: skill.description,
                  source: skill.source,
                },
              },
            }
          : {
              output: `Skill "${data.name}" is not available for this request.`,
              isError: true,
            };
      },
    ),
    defineTool(
      {
        name: "search_skills",
        guidance:
          "When the initial skill list is truncated or lacks a likely match, search the local skill catalog by name or description. Search is read-only and returns metadata. Pass a result name to load_skill when relevant. Use nextOffset to get more matches.",
        description:
          "Search all local skills eligible for model invocation. Returns up to 12 names and short descriptions, with a nextOffset when more match.",
        effect: "read",
        permission: "read",
        parallelSafe: true,
        outputPolicy: { maxInlineTokens: 2000 },
      },
      z.object({
        query: z.string().max(256).default(""),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      }),
      async (_context, input) => ({
        data: input,
        preview: input.query,
        resources: [],
      }),
      async (_context, { data }) => ({
        output: JSON.stringify(
          searchSkills(catalog(), data.query, data.offset),
        ),
      }),
    ),
    defineTool(
      {
        name: "create_skill",
        description:
          "Create or update a user skill in the managed library. Provide SKILL.md and optional references/scripts/assets; reserved names are rejected.",
        effect: "library_write",
        permission: "skills",
        parallelSafe: false,
      },
      z.object({
        name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
        files: z.record(z.string(), z.string()),
        mode: z.enum(["create", "update"]).default("create"),
      }),
      async (_context, input) => {
        if (isReservedSkillName(input.name))
          throw new Error(
            `Skill name "${input.name}" is reserved. Choose another name.`,
          );
        const files = Object.entries(input.files);
        if (
          !Object.hasOwn(input.files, "SKILL.md") ||
          files.length === 0 ||
          files.length > 32
        )
          throw new Error("Supply SKILL.md and no more than 32 skill files.");
        if (
          Buffer.byteLength(input.files["SKILL.md"] ?? "", "utf8") >
          64 * 1024
        )
          throw new Error("SKILL.md exceeds the 64 KB loader limit.");
        if (
          !parseSkillFile(
            input.name,
            input.files["SKILL.md"] ?? "",
            (error) => {
              throw new Error(`SKILL.md: ${error}`);
            },
          )
        )
          throw new Error(
            "SKILL.md needs a valid matching name, description, and instructions.",
          );
        let bytes = 0;
        for (const [path, content] of files) {
          if (
            path !== "SKILL.md" &&
            !/^(references|scripts|assets)\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(
              path,
            )
          )
            throw new Error(`Invalid skill file path: ${path}`);
          if (
            path
              .split("/")
              .some(
                (part) =>
                  part === "." ||
                  part === ".." ||
                  part.endsWith(".") ||
                  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
              )
          )
            throw new Error(`Invalid skill file path: ${path}`);
          bytes += Buffer.byteLength(content, "utf8");
        }
        if (bytes > 256_000)
          throw new Error("Skill files exceed the 256 KB limit.");
        const destination = join(userSkillsDir(), input.name);
        if (input.mode === "create" && (await pathExistsNoFollow(destination)))
          throw new Error(`User skill already exists: ${input.name}`);
        let updatePlan:
          | import("../editing/patch-plan.js").PatchPlan
          | undefined;
        if (input.mode === "update") {
          const info = await lstat(destination);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error(`Unsafe user skill directory: ${destination}`);
          await validateSkillWritePaths(destination, files);
          updatePlan = await skillEditing(destination).writeBatch(files);
        }
        return {
          data: { input, files, destination, updatePlan },
          preview: `${input.mode} user skill ${input.name} in ${destination}\nFiles: ${files.map(([name]) => name).join(", ")}`,
          resources: [destination],
        };
      },
      async (context, { data }) =>
        withSkillsLibraryLock(async (assertOwned) => {
          const { input, files, destination, updatePlan } = data;
          if (isReservedSkillName(input.name))
            throw new Error("Bundled skill names are reserved.");
          if (input.mode === "create") {
            if (await pathExistsNoFollow(destination))
              throw new Error(`User skill already exists: ${input.name}`);
            const temporary = join(userSkillsDir(), `.create-${randomUUID()}`);
            try {
              await mkdir(temporary);
              await writeSkillFiles(temporary, files, context.signal);
              if (await pathExistsNoFollow(destination))
                throw new Error(`User skill already exists: ${input.name}`);
              await assertOwned();
              await rename(temporary, destination);
            } finally {
              if (await exists(temporary))
                await rm(temporary, { recursive: true, force: true });
            }
          } else {
            const info = await lstat(destination);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw new Error(`Unsafe user skill directory: ${destination}`);
            await validateSkillWritePaths(destination, files);
            if (!updatePlan) throw new Error("Missing skill update preflight.");
            await assertOwned();
            await skillEditing(destination).commit(updatePlan, context.signal);
          }
          return {
            output: `User skill ${input.mode === "create" ? "created" : "updated"}: ${destination}`,
          };
        }, context.signal),
    ),
  ];
}
async function validateSkillWritePaths(
  root: string,
  files: [string, string][],
): Promise<void> {
  for (const [name] of files) {
    const parts = name.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (!(await pathExistsNoFollow(parent))) continue;
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Unsafe skill subdirectory: ${parent}`);
    }
    const target = join(parent, parts.at(-1) ?? "");
    if (!(await pathExistsNoFollow(target))) continue;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Unsafe skill file: ${target}`);
  }
}

async function writeSkillFiles(
  root: string,
  files: [string, string][],
  signal?: AbortSignal,
): Promise<void> {
  const editing = skillEditing(root);
  await editing.commit(await editing.writeBatch(files), signal);
}

/** Called only for the validated user-skill destination or its owned staging tree. */
function skillEditing(root: string): EditingService {
  return new EditingService(
    { root, resolve: (candidate) => resolveProjectPath(root, candidate) },
    {},
    false,
  );
}

async function pathExistsNoFollow(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
