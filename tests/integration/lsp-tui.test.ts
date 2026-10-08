import { test } from "bun:test";
import { runLspTuiScenario } from "../fixtures/tui-lsp-settings.js";

test("production TUI configures/trusts/starts real TypeScript via ordinary Settings actions and tool queue", async () => {
  await runLspTuiScenario();
}, 45_000);
