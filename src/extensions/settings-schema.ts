import { z } from "zod";
import type { SettingField, SettingValue } from "../extension-sdk/settings.js";

export const SettingNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine((name) => !["constructor", "prototype", "__proto__"].includes(name));
export const SettingValueSchema = z.union([
  z.boolean(),
  z.string().max(8192),
  z.number().finite(),
]);
export function validateSetting(
  field: SettingField,
  value: unknown,
): SettingValue | undefined {
  if (value === undefined) {
    if (field.required && field.default === undefined)
      throw new Error(`Заполните «${field.label}».`);
    return field.default;
  }
  let schema: z.ZodType;
  if (field.type === "boolean") schema = z.boolean();
  else if (field.type === "number") {
    let number = z.number().finite();
    if (field.integer) number = number.int();
    if (field.min !== undefined) number = number.min(field.min);
    if (field.max !== undefined) number = number.max(field.max);
    schema = number;
  } else {
    let string = z.string().max(field.maxLength ?? 8192);
    if (field.minLength !== undefined) string = string.min(field.minLength);
    if (field.required) string = string.min(1);
    schema =
      field.type === "enum"
        ? string.refine((v) => field.options?.some((o) => o.value === v))
        : string;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Недопустимое значение «${field.label}».`);
  return parsed.data as SettingValue;
}
const FieldSchema = z
  .strictObject({
    name: SettingNameSchema,
    label: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    type: z.enum(["boolean", "string", "number", "enum"]),
    default: SettingValueSchema.optional(),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    integer: z.boolean().optional(),
    minLength: z.number().int().min(0).max(8192).optional(),
    maxLength: z.number().int().min(1).max(8192).optional(),
    options: z
      .array(
        z.strictObject({
          value: z.string().min(1).max(256),
          label: z.string().min(1).max(120),
        }),
      )
      .min(1)
      .max(64)
      .optional(),
  })
  .superRefine((field, ctx) => {
    try {
      if (
        field.secret &&
        (field.type !== "string" || field.default !== undefined)
      )
        throw new Error("Секрет — string без default.");
      if ((field.type === "enum") !== !!field.options)
        throw new Error(
          "enum требует options; у остальных полей options запрещены.",
        );
      if (
        field.options &&
        new Set(field.options.map((o) => o.value)).size !== field.options.length
      )
        throw new Error("Повторные options.");
      if (
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      )
        throw new Error("min больше max.");
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      )
        throw new Error("minLength больше maxLength.");
      if (
        field.type !== "number" &&
        (field.min !== undefined ||
          field.max !== undefined ||
          field.integer !== undefined)
      )
        throw new Error("Числовая validation допустима только для number.");
      if (
        field.type !== "string" &&
        (field.minLength !== undefined || field.maxLength !== undefined)
      )
        throw new Error("Длина допустима только для string.");
      if (field.default !== undefined) validateSetting(field, field.default);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Некорректное поле.",
      });
    }
  });
export const SettingsSchemaValidator = z
  .strictObject({ fields: z.array(FieldSchema).max(64) })
  .refine(
    (schema) =>
      new Set(schema.fields.map((f) => f.name)).size === schema.fields.length,
    "Повторное имя поля.",
  );
