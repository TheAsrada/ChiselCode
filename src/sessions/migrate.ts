import type { Session } from "../types/domain.js";
export function legacyProfileId(providerId: string): string {
  return `${providerId.replaceAll("/", "-")}-default`;
}
export function migrateSessionRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid session record.");
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 2 &&
    value.schemaVersion !== 3 &&
    value.schemaVersion !== undefined
  )
    throw new Error("Unsupported session schemaVersion.");
  const { provider, ...fields } = value;
  const providerId = value.providerId ?? provider ?? "unknown";
  return {
    ...fields,
    schemaVersion: 3,
    providerId,
    profileId:
      value.profileId ??
      (typeof providerId === "string"
        ? legacyProfileId(providerId)
        : undefined),
  };
}
/** In-memory legacy alias only; never persisted. */
export function withSessionCompatibility(raw: unknown): Session {
  const session = migrateSessionRecord(raw) as unknown as Session;
  Object.defineProperty(session, "provider", {
    enumerable: false,
    configurable: true,
    get() {
      return this.providerId;
    },
    set(value: string) {
      this.providerId = value;
    },
  });
  return session;
}
