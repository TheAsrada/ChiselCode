import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateGlobalConfig } from "../config/load.js";
import { WorkspacePolicy } from "../security/workspace-policy.js";
import { withLock } from "../sessions/lock.js";
import type { GlobalConfig } from "../types/domain.js";
import { replaceAtomicFile } from "../utils/atomic-file.js";
import { ProjectBrowserConfigSchema } from "./config.js";

export async function toggleBrowser(
  root: string | undefined,
  configPath: string | undefined,
  enabled: boolean,
  projectBlocked: boolean,
  assertCurrent: (current: GlobalConfig) => void,
) {
  if (!projectBlocked || !enabled) {
    await updateGlobalConfig(configPath, (global) => {
      assertCurrent(global);
      return {
        ...global,
        browser: { origins: [], imageProfiles: [], ...global.browser, enabled },
      };
    });
    return;
  }
  if (!root) throw new Error("Выберите проект.");
  const path = await new WorkspacePolicy(root, []).resolve(".chiselrc");
  await withLock(path, async (assertOwned) => {
    const source = await readFile(path, "utf8");
    const config = JSON.parse(source) as Record<string, unknown>;
    const browser = ProjectBrowserConfigSchema.parse(config.browser);
    if (browser.enabled !== false)
      throw new Error("Настройки проекта изменились.");
    const temporary = join(root, `.chiselrc.${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ ...config, browser: { origins: browser.origins } }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      await replaceAtomicFile(temporary, path, async () => {
        await assertOwned();
        if ((await readFile(path, "utf8")) !== source)
          throw new Error("Настройки проекта изменились.");
      });
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
