import { z } from "zod";

export const EvalTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  fixture: z.string().min(1),
  prompt: z.string().min(1),
  timeout: z.number().positive().default(300),
  setup: z.array(z.string()).default([]),
  graders: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("command"), command: z.string() }),
      z.object({
        type: z.literal("file"),
        path: z.string(),
        contains: z.string().optional(),
        absent: z.boolean().optional(),
      }),
    ]),
  ),
  constraints: z
    .object({ forbidden_paths: z.array(z.string()).default([]) })
    .default({ forbidden_paths: [] }),
  tags: z.array(z.string()).default([]),
  mockCalls: z
    .array(
      z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }),
    )
    .default([]),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;
