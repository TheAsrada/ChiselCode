import { z } from "zod";

const line = z.string().min(1).max(240);
export const ChatStyleSchema = z
  .object({
    title: line,
    inputField: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      .optional(),
    view: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .optional(),
  })
  .strict()
  .transform(({ title, inputField, view }) => ({
    title,
    ...(inputField ? { inputField } : {}),
    ...(view ? { view } : {}),
  }));
export type ChatStyle = z.infer<typeof ChatStyleSchema>;

export const ChatCardSchema = z
  .object({
    id: z.string().min(1).max(160),
    revision: z.number().int().nonnegative(),
    title: line,
    subtitle: z.string().max(500).optional(),
    description: z.string().max(8192).optional(),
    detail: z.string().max(2048).optional(),
    status: z
      .object({
        label: line,
        tone: z.enum(["muted", "accent", "success", "warning", "error"]),
      })
      .strict()
      .optional(),
    target: z
      .object({ type: z.literal("subagent"), id: z.uuid() })
      .strict()
      .optional(),
  })
  .strict();
export type ChatCard = z.infer<typeof ChatCardSchema>;
export const ChatPresentationSchema = z
  .object({
    summary: z.string().min(1).max(2000).optional(),
    cards: z.array(ChatCardSchema).max(32).optional(),
  })
  .strict()
  .refine((value) => !!value.summary || !!value.cards?.length);
export type ChatPresentation = z.infer<typeof ChatPresentationSchema>;
export const OwnedChatPresentationSchema = z
  .object({
    extensionId: z.string().min(1).max(240),
    view: ChatPresentationSchema,
  })
  .strict();
export type OwnedChatPresentation = z.infer<typeof OwnedChatPresentationSchema>;
export interface OwnedChatCard {
  extensionId: string;
  card: ChatCard;
}

export interface ChatPresentationPort {
  render(
    extensionId: string,
    view: string,
    data: unknown,
  ): OwnedChatPresentation | undefined;
}
