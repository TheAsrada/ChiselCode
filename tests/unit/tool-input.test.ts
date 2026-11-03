import { expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../../src/tools/handler.js";
import { normalizeToolInput, parseToolInput } from "../../src/tools/input.js";

test("schema repair preserves nullable values, required fields, unknown options and exact strings", () => {
  const schema = z
    .object({
      command: z.string(),
      optional: z.number().optional(),
      nullable: z.number().nullable().optional(),
      required: z.string(),
      options: z.object({ enabled: z.boolean(), count: z.number().int() }),
    })
    .strict()
    .toJSONSchema();
  const input = {
    command: "echo 'literal null 0020 false \\n'",
    optional: null,
    nullable: null,
    required: null,
    options: { enabled: "false", count: "20" },
    misspelledSafetyOption: true,
  };
  const before = structuredClone(input);
  expect(normalizeToolInput(input, schema)).toEqual({
    value: {
      command: input.command,
      nullable: null,
      required: null,
      options: { enabled: false, count: 20 },
      misspelledSafetyOption: true,
    },
    corrections: ["optional", "options.enabled", "options.count"],
  });
  expect(input).toEqual(before);
});

test("schema repair leaves composed schemas, nullable enums, placeholders and ambiguous numbers unchanged", () => {
  for (const [schema, value] of [
    [{ type: "number" }, "0x10"],
    [{ type: "number" }, ""],
    [{ type: "number" }, "Infinity"],
    [{ type: "number" }, "1e999"],
    [{ type: "integer" }, "1.5"],
    [{ type: "integer" }, "9007199254740992"],
    [{ type: "boolean" }, "False"],
    [{ type: "array", items: { type: "integer" } }, "[1,2]"],
    [{ anyOf: [{ type: "number" }, { type: "null" }] }, "2"],
    [
      {
        type: "object",
        properties: { mode: { type: "string", enum: ["default", null] } },
      },
      { mode: null },
    ],
    [
      { type: "object", properties: { id: { type: "string" } } },
      { id: "00000000-0000-0000-0000-000000000000" },
    ],
    [
      {
        type: "object",
        properties: { required: { type: "string" } },
        required: ["required"],
      },
      { required: null },
    ],
    [
      {
        type: "object",
        properties: { option: { type: "number" } },
        anyOf: [{ required: ["option"] }],
      },
      { option: null },
    ],
  ])
    expect(normalizeToolInput(value, schema).value).toEqual(value);
});

test("validation after repair still enforces bounds and never prepares rejected input", () => {
  let prepared = false;
  const handler = defineTool(
    {
      name: "example",
      description: "fixture",
      effect: "read",
      permission: "read",
      parallelSafe: true,
    },
    z.object({ limit: z.number().int().min(1).max(10), id: z.uuid() }).strict(),
    async () => {
      prepared = true;
      return { data: {}, preview: "", resources: [] };
    },
    async () => ({ output: "" }),
  );
  const input = { limit: "20", id: "invalid" };
  expect(() => parseToolInput(handler, input)).toThrow("limit");
  expect(() => parseToolInput(handler, input)).toThrow("id");
  expect(prepared).toBe(false);
  expect(input.limit).toBe("20");
});
