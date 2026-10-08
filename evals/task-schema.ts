import { z } from "zod";

export const EvalTaskSchema = z.object({
  mockOnly: z.boolean().default(false),
  webFixture: z.boolean().default(false),
  lspFixture: z.boolean().default(false),
  webSearchBackend: z.enum(["brave", "exa", "parallel"]).default("brave"),
  id: z.string().regex(/^[a-z0-9-]+$/),
  fixture: z.string().min(1),
  prompt: z.string().min(1),
  timeout: z.number().positive().default(300),
  setup: z.array(z.string()).default([]),
  graders: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("command"), command: z.string() }),
      z.object({
        type: z.literal("trajectory"),
        event: z.string(),
        minimum: z.number().int().nonnegative().default(1),
        maximum: z.number().int().nonnegative().optional(),
      }),
      z.object({
        type: z.literal("file"),
        path: z.string(),
        contains: z.string().optional(),
        absent: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("tool_result"),
        tool: z.string(),
        errorCode: z.string().optional(),
        artifact: z.boolean().optional(),
        untrusted: z.boolean().optional(),
        maxOutputChars: z.number().int().positive().optional(),
        minimum: z.number().int().nonnegative().default(1),
        maximum: z.number().int().nonnegative().optional(),
        safety: z.boolean().default(false),
      }),
    ]),
  ),
  constraints: z
    .object({ forbidden_paths: z.array(z.string()).default([]) })
    .default({ forbidden_paths: [] }),
  tags: z.array(z.string()).default([]),
  context: z
    .object({
      contextWindow: z.number().int().positive().optional(),
      keepRecentTokens: z.number().int().nonnegative().optional(),
      maxInlineToolResultTokens: z.number().int().min(128).optional(),
    })
    .optional(),
  seedMessages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("text"), text: z.string() }),
            z.object({
              type: z.literal("tool_use"),
              id: z.string(),
              name: z.string(),
              input: z.record(z.string(), z.unknown()),
            }),
            z.object({
              type: z.literal("tool_result"),
              toolUseId: z.string(),
              content: z.string(),
              isError: z.boolean().optional(),
            }),
          ]),
        ),
      }),
    )
    .default([]),
  mockTurns: z
    .array(
      z.array(
        z.object({
          name: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
      ),
    )
    .optional(),
  mockCalls: z
    .array(
      z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }),
    )
    .default([]),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;
