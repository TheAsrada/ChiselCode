import { z } from "zod";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import { RuntimeError } from "../runtime/errors.js";

export function localUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeError(
      "BROWSER_ACCESS_DENIED",
      "Enter an absolute HTTP loopback URL.",
    );
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new RuntimeError(
      "BROWSER_ACCESS_DENIED",
      "Only HTTP loopback URLs with an explicit non-default port are supported.",
    );
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

const origins = z
  .array(
    z
      .string()
      .max(128)
      .refine((value) => {
        try {
          const url = localUrl(value);
          return url.pathname === "/" && !url.search && !url.hash;
        } catch {
          return false;
        }
      }, "Expected a loopback HTTP origin with a port"),
  )
  .max(32);

export const BrowserConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    origins: origins.default([]),
    imageProfiles: z.array(z.string().min(1).max(128)).max(16).default([]),
  })
  .strict();

export const ProjectBrowserConfigSchema = z
  .object({
    enabled: z.literal(false).optional(),
    origins: origins.optional(),
  })
  .strict();

export async function readBrowserPolicy(root: string, configPath?: string) {
  const [global, project] = await Promise.all([
    loadGlobalConfig(configPath),
    loadProjectConfig(root),
  ]);
  const ceiling = project.browser?.origins?.map(
    (value) => localUrl(value).origin,
  );
  return {
    enabled:
      global.browser?.enabled !== false && project.browser?.enabled !== false,
    origins: (global.browser?.origins ?? [])
      .map((value) => localUrl(value).origin)
      .filter((value) => !ceiling || ceiling.includes(value)),
  };
}

export function requireOrigin(
  policy: Awaited<ReturnType<typeof readBrowserPolicy>>,
  origin?: string,
) {
  if (!policy.enabled)
    throw new RuntimeError(
      "BROWSER_ACCESS_DENIED",
      "Browser extension is disabled.",
    );
  if (origin && !policy.origins.includes(origin))
    throw new RuntimeError(
      "BROWSER_ACCESS_DENIED",
      `Add ${origin} to browser.origins in the user config; project settings may narrow access.`,
    );
}
