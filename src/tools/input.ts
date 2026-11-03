import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";
import type { JsonObject } from "../types/domain.js";
import type { ToolHandler } from "./types.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const composed = (schema: Record<string, unknown>) =>
  [
    "$ref",
    "allOf",
    "anyOf",
    "oneOf",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "dependentRequired",
  ].some((key) => key in schema);

/** Representation repair only: never guess names, IDs, paths, commands or missing required values. */
export function normalizeToolInput(value: unknown, schema: unknown) {
  const corrections: string[] = [];
  const note = (path: string) => {
    if (corrections.length < 16) corrections.push(path.slice(0, 160));
  };
  const visit = (
    current: unknown,
    definition: unknown,
    path: string,
    depth: number,
  ): unknown => {
    if (depth > 6 || !object(definition) || composed(definition))
      return current;
    if (typeof current === "string") {
      if (
        (definition.type === "number" || definition.type === "integer") &&
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(current.trim())
      ) {
        const number = Number(current);
        if (
          Number.isFinite(number) &&
          (definition.type !== "integer" || Number.isSafeInteger(number))
        ) {
          note(path);
          return number;
        }
      }
      if (
        definition.type === "boolean" &&
        (current === "true" || current === "false")
      ) {
        note(path);
        return current === "true";
      }
    }
    if (
      definition.type === "array" &&
      Array.isArray(current) &&
      !definition.prefixItems &&
      !Array.isArray(definition.items)
    )
      return current.map((item, index) =>
        visit(item, definition.items, `${path}[${index}]`, depth + 1),
      );
    if (definition.type !== "object" || !object(current)) return current;
    const properties = object(definition.properties)
      ? definition.properties
      : {};
    const required = Array.isArray(definition.required)
      ? definition.required
      : [];
    return Object.fromEntries(
      Object.entries(current).flatMap(([key, item]) => {
        const declared = Object.hasOwn(properties, key);
        const property = declared ? properties[key] : undefined;
        const field = path ? `${path}.${key}` : key;
        if (
          declared &&
          !required.includes(key) &&
          item === null &&
          object(property) &&
          typeof property.type === "string" &&
          property.type !== "null" &&
          !composed(property) &&
          !["const", "nullable"].some((keyword) => keyword in property) &&
          !(Array.isArray(property.enum) && property.enum.includes(null))
        ) {
          note(field);
          return [];
        }
        // Unknown fields remain visible to the validator. Never silently discard a misspelled safety option.
        return [[key, visit(item, property, field, depth + 1)]];
      }),
    );
  };
  return { value: visit(value, schema, "", 0), corrections };
}

export function parseToolInput(handler: ToolHandler, value: unknown) {
  const normalized = normalizeToolInput(value, handler.spec.inputSchema);
  try {
    return {
      input: handler.parse(normalized.value as JsonObject),
      corrections: normalized.corrections,
    };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error instanceof z.ZodError) {
      const problems = error.issues
        .slice(0, 6)
        .map(
          (issue) =>
            `${issue.path.map(String).join(".").slice(0, 160) || "input"}: ${issue.message.slice(0, 240)}`,
        );
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        `${problems.join("; ")} Исправьте указанные поля по схеме инструмента; прежний вызов не выполнен.`,
      );
    }
    throw new RuntimeError("INVALID_TOOL_INPUT", String(error));
  }
}
