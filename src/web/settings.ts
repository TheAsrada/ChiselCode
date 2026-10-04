import { loadGlobalConfig, saveGlobalConfig } from "../config/load.js";
import {
  type CredentialStorage,
  CredentialStore,
} from "../security/credentials.js";
import { SecretRedactor } from "../security/redaction.js";
import { resolveWebConfig, type WebConfig, WebConfigSchema } from "./schema.js";
import { resolveWebCredential } from "./search.js";

export interface WebSettingsState {
  config: WebConfig;
  hasKey: boolean;
}
export interface WebSettingsActions {
  load(): Promise<WebSettingsState>;
  save(config: WebConfig, apiKey?: string): Promise<WebSettingsState>;
}
const writes = new Map<string, Promise<unknown>>();
/** Only user configuration can grant network permission. Never writes .chiselrc. */
export class WebSettingsStore implements WebSettingsActions {
  constructor(
    private readonly path?: string,
    private readonly credentials: CredentialStorage = new CredentialStore(),
  ) {}
  async load(): Promise<WebSettingsState> {
    const config = resolveWebConfig((await loadGlobalConfig(this.path)).web);
    return {
      config,
      hasKey: Boolean(
        await resolveWebCredential(
          config,
          new SecretRedactor(false),
          this.credentials,
        ),
      ),
    };
  }
  async save(value: WebConfig, apiKey?: string): Promise<WebSettingsState> {
    const config = WebConfigSchema.parse(value);
    const scope = this.path ?? "global";
    const task = (writes.get(scope) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (apiKey !== undefined) {
          const key = apiKey.trim();
          if (
            key.length < 8 ||
            key.length > 8192 ||
            [...key].some(
              (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126,
            )
          )
            throw new Error(
              "Введите действительный API-ключ Brave без пробелов.",
            );
          await this.credentials.set("web/brave-search", key);
          config.search.apiKey = { secretRef: "web/brave-search" };
        }
        const current = await loadGlobalConfig(this.path);
        await saveGlobalConfig({ ...current, web: config }, this.path);
        return this.load();
      });
    writes.set(scope, task);
    try {
      return await task;
    } finally {
      if (writes.get(scope) === task) writes.delete(scope);
    }
  }
}
