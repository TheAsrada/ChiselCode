import { z } from "zod";
import {
  customProviderIdSchema,
  endpointSchema,
  envVarNameSchema,
  providerCapabilitiesSchema,
} from "../registry.js";
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const CustomProviderManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: customProviderIdSchema,
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  driver: z.string().trim().min(1),
  auth: z.strictObject({
    required: z.boolean(),
    envVars: z.array(envVarNameSchema).max(10),
  }),
  endpoint: endpointSchema,
  defaults: z.strictObject({ model: z.string().trim().min(1).optional() }),
  capabilities: providerCapabilitiesSchema,
  driverOptions: z.record(z.string(), z.unknown()).optional(),
  author: z.string().max(100).optional(),
  homepage: z.url().optional(),
  license: z.string().max(100).optional(),
});
export function containsSecretFields(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /^(api[_-]?key|token|secret|password|authorization)$/i.test(key) ||
      containsSecretFields(item),
  );
}
