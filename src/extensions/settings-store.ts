import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ExtensionSettings } from "../desktop/protocol.js";
import type { SettingValue } from "../extension-sdk/settings.js";
import { CredentialStore } from "../security/credentials.js";
import { registerExtensionSecret } from "../security/redaction.js";
import { withLock } from "../sessions/lock.js";
import {
  type ExtensionManifest,
  ExternalIdSchema,
} from "./external/manifest.js";
import { frozenClone } from "./lifecycle.js";
import { PackageManagementError } from "./packages/errors.js";
import {
  atomicPackageJson,
  boundedJson,
  packageDirectory,
} from "./packages/storage.js";
import {
  SettingNameSchema,
  SettingValueSchema,
  validateSetting,
} from "./settings-schema.js";

const StoredSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    values: z.record(SettingNameSchema, SettingValueSchema),
    secrets: z.record(SettingNameSchema, z.string().max(256)),
  })
  .refine(
    (v) => Object.keys(v.values).length + Object.keys(v.secrets).length <= 128,
  );
type Stored = z.infer<typeof StoredSchema>;
/** Global per-id state is retained on update, rollback and package removal. */
export class ExtensionSettingsStore {
  constructor(private readonly manifest: ExtensionManifest) {}
  private async path() {
    return join(
      await packageDirectory(".settings"),
      `${ExternalIdSchema.parse(this.manifest.id)}.json`,
    );
  }
  private async stored(): Promise<Stored> {
    try {
      return StoredSchema.parse(
        await boundedJson(await this.path(), 128 * 1024),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { schemaVersion: 1, revision: 0, values: {}, secrets: {} };
    }
  }
  private view(state: Stored): ExtensionSettings {
    const schema = this.manifest.settings ?? { fields: [] },
      values: Record<string, SettingValue> = {},
      secretSet: Record<string, boolean> = {},
      issues: string[] = [];
    for (const field of schema.fields) {
      if (field.secret) {
        secretSet[field.name] = !!state.secrets[field.name];
        if (field.required && !secretSet[field.name])
          issues.push(`Заполните «${field.label}».`);
        continue;
      }
      try {
        const value = validateSetting(field, state.values[field.name]);
        if (value !== undefined) values[field.name] = value;
      } catch {
        issues.push(
          `Проверьте «${field.label}»: сохранённое значение не подходит новой схеме.`,
        );
        if (field.default !== undefined) values[field.name] = field.default;
      }
    }
    const names = new Set(schema.fields.map((f) => f.name));
    return frozenClone({
      id: this.manifest.id,
      schema,
      revision: state.revision,
      values,
      secretSet,
      unknownKeys: [
        ...new Set([
          ...Object.keys(state.values),
          ...Object.keys(state.secrets),
        ]),
      ].filter((k) => !names.has(k)),
      issues,
      restartRequired: true,
    });
  }
  async read(): Promise<ExtensionSettings> {
    return this.view(await this.stored());
  }
  async save(input: {
    revision: number;
    values: Record<string, SettingValue>;
    secrets?: Record<string, string>;
    clearSecrets?: string[];
    reset?: boolean;
  }): Promise<ExtensionSettings> {
    const fields = this.manifest.settings?.fields ?? [];
    if (!fields.length) throw new Error("У этого расширения нет настроек.");
    for (const key of Object.keys(input.values))
      if (!fields.some((f) => f.name === key && !f.secret))
        throw new Error("Неизвестное поле настройки.");
    for (const key of [
      ...Object.keys(input.secrets ?? {}),
      ...(input.clearSecrets ?? []),
    ])
      if (!fields.some((f) => f.name === key && f.secret))
        throw new Error("Неизвестное секретное поле.");
    for (const value of Object.values(input.secrets ?? {}))
      registerExtensionSecret(value);
    return withLock(await this.path(), async (assertOwned) => {
      const state = await this.stored();
      if (state.revision !== input.revision)
        throw new PackageManagementError(
          "PACKAGE_CONFLICT",
          "Настройки изменились. Перечитайте их перед новым подтверждением; draft сохранён.",
        );
      const next = structuredClone(state),
        created: string[] = [],
        retired: string[] = [],
        credentials = new CredentialStore();
      try {
        for (const field of fields) {
          if (field.secret) {
            const clear =
              input.reset || input.clearSecrets?.includes(field.name);
            const secret = input.secrets?.[field.name];
            if (clear || secret !== undefined) {
              if (next.secrets[field.name])
                retired.push(next.secrets[field.name]!);
              delete next.secrets[field.name];
              if (!clear && secret !== undefined) {
                validateSetting(field, secret);
                const ref = `extension:${this.manifest.id}:${field.name}:${randomUUID()}`;
                await credentials.set(ref, secret);
                created.push(ref);
                next.secrets[field.name] = ref;
              }
              // A formerly public field that became secret is never exposed again.
              delete next.values[field.name];
            }
            if (!input.reset && field.required && !next.secrets[field.name])
              throw new Error(`Заполните «${field.label}».`);
          } else {
            if (input.reset) {
              delete next.values[field.name];
              continue;
            }
            const value = validateSetting(
              field,
              input.reset
                ? undefined
                : (input.values[field.name] ?? next.values[field.name]),
            );
            delete next.values[field.name];
            if (value !== undefined) next.values[field.name] = value;
          }
        }
        next.revision++;
        await atomicPackageJson(
          await this.path(),
          StoredSchema.parse(next),
          assertOwned,
        );
      } catch (error) {
        await Promise.allSettled(created.map((ref) => credentials.delete(ref)));
        throw error;
      }
      await Promise.allSettled(retired.map((ref) => credentials.delete(ref)));
      return this.view(next);
    });
  }
  async runtimeSnapshot() {
    const state = await this.stored(),
      view = this.view(state),
      secrets: Record<string, string> = {};
    if (view.issues.length)
      throw new Error(
        "Настройки расширения не соответствуют схеме; откройте настройки.",
      );
    for (const field of this.manifest.settings?.fields ?? [])
      if (field.secret) {
        const ref = state.secrets[field.name],
          value = ref ? await new CredentialStore().get(ref) : undefined;
        if (field.required && !value)
          throw new Error("Обязательная секретная настройка не задана.");
        if (value !== undefined) {
          registerExtensionSecret(value);
          secrets[field.name] = value;
        }
      }
    return {
      values: frozenClone(view.values),
      secrets: Object.freeze(secrets),
      revision: state.revision,
    };
  }
}
