import type {
  AuthProvider,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { RuntimeError } from "../runtime/errors.js";
import {
  type CredentialStorage,
  CredentialStore,
} from "../security/credentials.js";
import type { McpRedactor } from "./redaction.js";
import type { McpServerConfig, McpValue } from "./schema.js";

/** SDK authorization seam: bearer today; an SDK OAuth provider can be supplied later. */
export interface McpAuthentication {
  resolve(
    server: McpServerConfig,
    redactor: McpRedactor,
  ): Promise<AuthProvider | OAuthClientProvider | undefined>;
}
export class McpCredentialResolver implements McpAuthentication {
  constructor(
    readonly store: CredentialStorage = new CredentialStore(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}
  async value(ref: McpValue, redactor: McpRedactor): Promise<string> {
    if ("literal" in ref) return ref.literal;
    const value =
      "secretRef" in ref
        ? await this.store.get(ref.secretRef)
        : this.environment[ref.envRef];
    if (!value)
      throw new RuntimeError(
        "MCP_AUTH_REQUIRED",
        "Не найдены учётные данные. Добавьте секрет или задайте переменную окружения.",
        { retryable: false },
      );
    redactor.add(value);
    return value;
  }
  async values(
    refs: Record<string, McpValue>,
    redactor: McpRedactor,
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const [key, ref] of Object.entries(refs))
      values[key] = await this.value(ref, redactor);
    return values;
  }
  async resolve(
    server: McpServerConfig,
    redactor: McpRedactor,
  ): Promise<AuthProvider | undefined> {
    if (!server.auth) return;
    const token = await this.value(server.auth.token, redactor);
    return { token: async () => token };
  }
}
