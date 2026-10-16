import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  EXTENSION_MANIFEST,
  ExtensionManifestSchema,
} from "../../extensions/external/manifest.js";
import { packageRelativePath } from "../../extensions/packages/paths.js";
import { PackageManagementService } from "../../extensions/packages/service.js";
import { cancelled } from "../../runtime/errors.js";
import { defineTool } from "../handler.js";

/** Authoring writes enter the same managed, atomic installer as Settings and the CLI. */
export function createExtensionHandler() {
  return defineTool(
    {
      name: "create_extension",
      description:
        "Validate and install a new self-contained ChiselCode extension, disabled and untrusted. Supply chisel-extension.json and ESM files. Does not execute the module or grant trust. Load extension-creator for the UI SDK and examples.",
      effect: "library_write",
      permission: "extensions",
      parallelSafe: false,
    },
    z.object({ files: z.record(z.string(), z.string()) }).strict(),
    async (_context, input) => {
      const files = Object.entries(input.files);
      if (!files.length || files.length > 32)
        throw new Error("Supply 1–32 extension files.");
      const manifest = ExtensionManifestSchema.parse(
        JSON.parse(input.files[EXTENSION_MANIFEST] ?? "null"),
      );
      if (!Object.hasOwn(input.files, manifest.entry))
        throw new Error("The manifest entry is missing.");
      let bytes = 0;
      const parser = new Bun.Transpiler({ loader: "js", target: "bun" });
      for (const [name, content] of files) {
        packageRelativePath(name);
        bytes += Buffer.byteLength(content);
        if (bytes > 512 * 1024)
          throw new Error("Extension authoring is limited to 512 KiB.");
        if (name.endsWith(".mjs")) {
          // Parse without import/factory execution, then check local dependency closure.
          parser.transformSync(content);
          if (
            name === manifest.entry &&
            !parser.scan(content).exports.includes("default")
          )
            throw new Error("The ESM entry needs a default factory export.");
          for (const dependency of parser.scanImports(content)) {
            if (
              dependency.path.startsWith("node:") ||
              dependency.path === "bun"
            )
              continue;
            if (
              !dependency.path.startsWith("./") &&
              !dependency.path.startsWith("../")
            )
              throw new Error(
                `Bundle external dependency ${dependency.path} into the extension.`,
              );
            const target = join(dirname(name), dependency.path).replaceAll(
              "\\",
              "/",
            );
            packageRelativePath(target);
            if (!Object.hasOwn(input.files, target))
              throw new Error(`Missing dependency: ${target}`);
          }
        }
      }
      return {
        data: { files, manifest },
        preview: `Создать расширение «${manifest.displayName}» (${manifest.id})\n${files.length} файлов, ${bytes} байт. Установить выключенным, без доверия и запуска кода.`,
        resources: [`extension:${manifest.id}`],
      };
    },
    async (context, { data }) => {
      cancelled(context.signal);
      const directory = await mkdtemp(
        join(tmpdir(), "chisel-extension-author-"),
      );
      const packages = new PackageManagementService();
      let candidate:
        | Awaited<ReturnType<typeof packages.prepareInstall>>
        | undefined;
      try {
        for (const [name, content] of data.files) {
          cancelled(context.signal);
          const path = join(directory, name);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, {
            flag: "wx",
            signal: context.signal,
          });
        }
        candidate = await packages.prepareInstall(directory, {
          signal: context.signal,
        });
        const result = await packages.commitCandidate(candidate, {
          enabled: false,
          signal: context.signal,
        });
        return {
          output: `Расширение «${data.manifest.displayName}» установлено выключенным. Откройте Настройки → Расширения → ${data.manifest.id} → Доверить и включить.\nDigest: ${candidate.preview.digest}\nКод не выполнялся; доверие не выдано.`,
          details: {
            extension: {
              id: result.id,
              digest: candidate.preview.digest,
              enabled: false,
              trusted: false,
            },
          },
        };
      } finally {
        await Promise.allSettled([
          ...(candidate ? [packages.abortCandidate(candidate)] : []),
          rm(directory, { recursive: true, force: true }),
        ]);
      }
    },
  );
}
