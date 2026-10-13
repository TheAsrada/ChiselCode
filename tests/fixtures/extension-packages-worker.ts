import { createInterface } from "node:readline/promises";
import { ExternalExtensionLoader } from "../../src/extensions/external/loader.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import {
  type PackageFaultPoint,
  PackageManagementService,
} from "../../src/extensions/packages/service.js";

const [mode, workspace, source, fault] = process.argv.slice(2);
const input = createInterface({ input: process.stdin, terminal: false });
const next = async () => {
  for await (const line of input) return line;
  throw new Error("Fixture control pipe закрыт.");
};
try {
  if (mode === "use") {
    const loader = await ExternalExtensionLoader.create(() => {}),
      host = new ExtensionHost(loader.definitions([]));
    await host.open(workspace!);
    console.log(
      JSON.stringify({ ready: true, diagnostics: loader.metadata() }),
    );
    await next();
    await host.dispose();
  } else if (mode === "fault") {
    const service = new PackageManagementService({
      fault: async (point: PackageFaultPoint, operationId: string) => {
        if (point === fault) {
          console.log(JSON.stringify({ point, operationId }));
          await next();
        }
      },
    });
    const candidate = await service.prepareInstall(source!);
    await service.commitCandidate(candidate, {
      digest: candidate.preview.digest,
      acknowledgeProcessAccess: true,
      enabled: true,
    });
  } else if (mode === "install") {
    const service = new PackageManagementService();
    try {
      const candidate = await service.prepareInstall(source!);
      console.log(JSON.stringify(await service.commitCandidate(candidate)));
    } catch {
      console.log(JSON.stringify({ outcome: "conflict" }));
      process.exitCode = 1;
    }
  } else throw new Error("Неизвестный fixture mode.");
} finally {
  input.close();
}
