import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ProviderDiagnostic, RegisteredProvider } from "../contracts.js";
import { builtinDefinitions } from "../definitions/index.js";
import type { DriverRegistry } from "../drivers/index.js";
import {
  CustomProviderManifestV1Schema,
  containsSecretFields,
  MAX_MANIFEST_BYTES,
} from "./schema.js";
export async function loadCustomProvider(
  directory: string,
  drivers: DriverRegistry,
): Promise<{
  provider?: RegisteredProvider;
  diagnostics: ProviderDiagnostic[];
}> {
  const path = join(directory, "provider.json");
  const diagnostics: ProviderDiagnostic[] = [];
  const error = (
    code: ProviderDiagnostic["code"],
    message: string,
    providerId?: string,
  ) => ({
    diagnostics: [
      { severity: "error" as const, code, path, providerId, message },
    ],
  });
  try {
    const packageStat = await lstat(directory);
    if (packageStat.isSymbolicLink())
      return error(
        "unsafe_symlink",
        "Symlink/junction provider directories are disabled.",
      );
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      return error(
        "unsafe_symlink",
        "provider.json must be a regular file, not a symlink.",
      );
    const root = await realpath(directory);
    const resolved = await realpath(path);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel))
      return error("unsafe_symlink", "Manifest is outside its package.");
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let text: string;
    try {
      const stat = await handle.stat();
      if (stat.size > MAX_MANIFEST_BYTES)
        return error("manifest_too_large", "Manifest exceeds 256 KiB.");
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          used,
          buffer.length - used,
          null,
        );
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > MAX_MANIFEST_BYTES)
        return error("manifest_too_large", "Manifest exceeds 256 KiB.");
      text = buffer.subarray(0, used).toString("utf8");
    } finally {
      await handle.close();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return error("manifest_invalid", "Invalid provider.json JSON.");
    }
    if (containsSecretFields(raw))
      return error(
        "manifest_invalid",
        "Secret fields are forbidden in provider.json; use envVars and profile.apiKeyRef.",
      );
    const object = raw as { schemaVersion?: unknown; id?: unknown };
    if (object?.schemaVersion !== 1)
      return error(
        "unsupported_schema",
        "Unsupported custom provider manifest schemaVersion; expected 1.",
      );
    if (builtinDefinitions.some((d) => d.id === object.id))
      return error(
        "reserved_id",
        "Custom providers cannot replace built-in IDs.",
      );
    const parsed = CustomProviderManifestV1Schema.safeParse(raw);
    if (!parsed.success)
      return error(
        "manifest_invalid",
        "Manifest does not match schema v1 (check ID, endpoint, env vars and required fields).",
      );
    const {
      driver,
      schemaVersion: _version,
      author: _author,
      homepage: _homepage,
      license: _license,
      ...fields
    } = parsed.data;
    const definition = { ...fields, driverId: driver };
    const implementation = drivers.get(driver);
    if (!implementation)
      return error(
        "unknown_driver",
        `Unknown driver "${driver}".`,
        definition.id,
      );
    const issues = implementation.validateDefinition?.(definition) ?? [];
    if (issues.some((d) => d.severity === "error"))
      return { diagnostics: issues.map((d) => ({ ...d, path })) };
    diagnostics.push(...issues.map((d) => ({ ...d, path })));
    if (definition.endpoint.defaultBaseUrl) {
      const url = new URL(definition.endpoint.defaultBaseUrl);
      if (
        url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        diagnostics.push({
          severity: "warning",
          code: "insecure_endpoint",
          path,
          providerId: definition.id,
          message:
            "Remote HTTP endpoint may transmit API keys and prompts without TLS.",
        });
    }
    return {
      provider: {
        definition,
        source: { type: "user-manifest", directory, manifestPath: path },
      },
      diagnostics,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return error("manifest_invalid", "Missing provider.json.");
    return error("manifest_invalid", "Cannot safely read provider.json.");
  }
}
