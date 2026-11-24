import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { automationDispatcher } from "../../src/app/run-automation.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExternalExtensionLoader } from "../../src/extensions/external/loader.js";
import { ExtensionHost } from "../../src/extensions/host.js";

const [root, configPath, phase] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const builtins = defaultExtensions(
  [
    {
      id: "builtin.fixture",
      activate(context) {
        context.automations.register({
          id: "builtin-once",
          schedule: { kind: "once", at: "2020-01-01T00:00:00Z" },
          tool: { name: "read_file", input: { path: "count.cjs" } },
        });
      },
    },
  ],
  { configPath },
);
const loader = await ExternalExtensionLoader.create(() => {}, "standard");
const host = new ExtensionHost([...builtins, ...loader.definitions(builtins)]);
host.configureAutomations((scope) =>
  automationDispatcher(scope, { configPath }, () => ({
    mode: "build",
    resolver: {
      async requestApproval(request, signal) {
        if (phase === "crash" && request.command?.includes("external")) {
          await writeFile(join(root, "approval-pending"), "");
          return new Promise((done) =>
            signal?.addEventListener("abort", () => done("unavailable"), {
              once: true,
            }),
          );
        }
        return "approved";
      },
    },
  })),
);
try {
  const scope = await host.open(root);
  const expected = phase === "restart" ? "interrupted" : "succeeded";
  const deadline = Date.now() + 12000;
  for (;;) {
    const external =
      scope.automations.list("fixture.automation")[0]?.last?.status;
    const builtin = scope.automations.list("builtin.fixture")[0]?.last?.status;
    if (external === expected && builtin === "succeeded") break;
    if (
      phase === "crash" &&
      external === "accepted" &&
      builtin === "succeeded" &&
      (await Bun.file(join(root, "approval-pending")).exists())
    )
      await writeFile(join(root, "approval-ready"), "");
    if (Date.now() > deadline)
      throw Error(
        JSON.stringify({
          external,
          builtin,
          expected,
          tasks: scope.automations.list("fixture.automation"),
        }),
      );
    await Bun.sleep(40);
  }
} finally {
  await host.dispose();
}
