import type { Skill } from "../../skills/skills.js";
import { editingHandlers } from "../editing/handlers.js";
import type { ToolProvider } from "../types.js";
import { fileHandlers } from "./files.js";
import { gitHandlers } from "./git.js";
import { shellHandler } from "./shell.js";
import { skillHandlers } from "./skills.js";
export class LocalToolProvider implements ToolProvider {
  readonly handlers = [
    ...fileHandlers(),
    ...editingHandlers(),
    shellHandler(),
    ...gitHandlers(),
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
  constructor(skills: readonly Skill[]) {
    this.handlers = skillHandlers([...skills]);
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
