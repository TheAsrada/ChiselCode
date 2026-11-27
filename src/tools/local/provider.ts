import { attestNativeSkillTool } from "../../skills/capability.js";
import type { LoadedMcpSkill } from "../../skills/mcp.js";
import { RemoteSkills } from "../../skills/remote.js";
import { SafeWebHttpClient } from "../../web/http-client.js";
import { WebLimitsSchema } from "../../web/schema.js";
import { editingHandlers } from "../editing/handlers.js";
import type { ToolProvider } from "../types.js";
import { createExtensionHandler } from "./extensions.js";
import { fileHandlers } from "./files.js";
import { gitHandlers } from "./git.js";
import { scratchHandler } from "./scratch.js";
import { shellHandler } from "./shell.js";
import { skillSourceHandlers } from "./skill-sources.js";
import { type SkillsCatalog, skillHandlers } from "./skills.js";
export class LocalToolProvider implements ToolProvider {
  readonly handlers = [
    ...fileHandlers(),
    ...editingHandlers(),
    shellHandler(),
    scratchHandler(),
    ...gitHandlers(),
    createExtensionHandler(),
  ];
  async listTools() {
    return this.handlers.map((handler) => handler.spec);
  }
  async getHandler(name: string) {
    const handler = this.handlers.find((item) => item.spec.name === name);
    if (!handler) throw new Error(`Unknown local tool: ${name}`);
    return handler;
  }
}
export class SkillsToolProvider implements ToolProvider {
  readonly handlers;
  constructor(
    skills: SkillsCatalog,
    remote = new RemoteSkills(new SafeWebHttpClient(WebLimitsSchema.parse({}))),
    mcpSkill?: LoadedMcpSkill,
  ) {
    this.handlers = [
      ...skillHandlers(
        typeof skills === "function" ? skills : [...skills],
        mcpSkill,
      ),
      ...skillSourceHandlers(remote),
    ];
    for (const handler of this.handlers) {
      handler.spec.source = { type: "skill" };
      attestNativeSkillTool(handler);
    }
  }
  async listTools() {
    return this.handlers.map((handler) => handler.spec);
  }
  async getHandler(name: string) {
    const handler = this.handlers.find((item) => item.spec.name === name);
    if (!handler) throw new Error(`Unknown skills tool: ${name}`);
    return handler;
  }
}
