import { z } from "zod";

export function reasoningEffortOptions<T extends string>(levels: readonly T[]) {
  const level = z.enum(levels);
  return z
    .record(
      z.string().trim().min(1),
      z
        .strictObject({
          levels: z
            .array(level)
            .min(1)
            .refine((items) => new Set(items).size === items.length),
          defaultLevel: level.optional(),
        })
        .refine(
          ({ levels, defaultLevel }) =>
            defaultLevel === undefined || levels.includes(defaultLevel),
        ),
    )
    .optional();
}
