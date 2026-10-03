import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  chiselHomeDir,
  skillsRootDir,
  userSkillsDir,
} from "../../paths/home.js";
import { WorkspacePolicy } from "../../security/workspace-policy.js";
import {
  isReservedSkillName,
  parseSkillFile,
  type Skill,
} from "../../skills/skills.js";
import { exists } from "../../utils/paths.js";
import { EditingService } from "../editing/service.js";
import { defineTool } from "../handler.js";
export function skillHandlers(skills: readonly Skill[]) {
  return [
    defineTool(
      {
        name: "load_skill",
        description:
          "Read an advertised skill's instructions without granting permissions.",
        effect: "read",
        permission: "read",
        parallelSafe: true,
      },
      z.object({ name: z.string().min(1) }),
      async (_context, input) => ({
        data: input,
        preview: input.name,
        resources: [],
      }),
      async (_context, { data }) => {
        const skill = skills.find(
          (item) => item.name === data.name && !item.disableModelInvocation,
        );
        return skill
          ? { output: skill.instructions }
          : {
              output: `Skill "${data.name}" is not available for automatic loading.`,
              isError: true,
            };
      },
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
        if (!parseSkillFile(input.name, input.files["SKILL.md"] ?? ""))
          throw new Error(
            "SKILL.md needs a valid matching name, description, and instructions.",
          );
        if (
          Buffer.byteLength(input.files["SKILL.md"] ?? "", "utf8") >
          64 * 1024
        )
          throw new Error("SKILL.md exceeds the 64 KB loader limit.");
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
          updatePlan = await new EditingService(
            new WorkspacePolicy(destination, []),
            {},
            false,
          ).writeBatch(files);
        }
        return {
          data: { input, files, destination, updatePlan },
          preview: `${input.mode} user skill ${input.name} in ${destination}\nFiles: ${files.map(([name]) => name).join(", ")}`,
          resources: [destination],
        };
      },
      async (context, { data }) => {
        const { input, files, destination, updatePlan } = data;
        for (const path of [
          chiselHomeDir(),
          skillsRootDir(),
          userSkillsDir(),
        ]) {
          await mkdir(path, { recursive: true });
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error(`Unsafe ChiselCode skills directory: ${path}`);
        }
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
          await new EditingService(
            new WorkspacePolicy(destination, []),
            {},
            false,
          ).commit(updatePlan, context.signal);
        }
        return {
          output: `User skill ${input.mode === "create" ? "created" : "updated"}: ${destination}`,
        };
      },
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
  const editing = new EditingService(new WorkspacePolicy(root, []), {}, false);
  await editing.commit(await editing.writeBatch(files), signal);
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
