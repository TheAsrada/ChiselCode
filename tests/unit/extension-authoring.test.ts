import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPackage } from "../../src/extensions/external/package.js";
import { extensionRecords } from "../../src/extensions/external/registry.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ProjectConfig, Session } from "../../src/types/domain.js";

const config: ProjectConfig = {
  allowedCommands: [],
  deniedCommands: [],
  ignorePatterns: [],
  autoApprove: false,
};
const manifest = {
  schemaVersion: 1,
  id: "personal.authoring",
  version: "1.0.0",
  apiVersion: 1,
  kind: "ui",
  entry: "index.mjs",
  displayName: "Моя панель",
};
const files = {
  "chisel-extension.json": JSON.stringify(manifest),
  "index.mjs":
    "globalThis.__chiselUnapprovedImport = true; export default ({manifest}) => ({id:manifest.id,version:manifest.version,apiVersion:1,entry:manifest.entry,activate(){}});",
};
test("authoring rejects escapes, missing modules, syntax errors and reserved IDs before permission; deny and Plan never install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-extension-author-"));
  const envName =
      process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME",
    previous = process.env[envName];
  process.env[envName] = directory;
  const requests: ApprovalRequest[] = [];
  const gate = new ApprovalGate(
    config,
    { autoApprove: false, nonInteractive: false, allowedTools: new Set() },
    {
      async requestApproval(request) {
        requests.push(request);
        return "denied";
      },
    },
  );
  const session = {
    id: "author",
    projectPath: directory,
    mode: "build",
    messages: [],
    provider: "anthropic",
    providerId: "anthropic",
    profileId: "fixture",
    model: "fixture",
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    totalCost: 0,
    undoStack: [],
    createdAt: "",
    updatedAt: "",
  } as Session;
  const tools = new ToolRegistry(directory, [], gate, session);
  try {
    for (const path of [
      "../escape.mjs",
      "/tmp/escape.mjs",
      "C:/escape.mjs",
      "lib\\escape.mjs",
      "assets/CON.txt",
    ])
      expect(
        (
          await tools.execute("create_extension", {
            files: { ...files, [path]: "" },
          })
        ).isError,
        path,
      ).toBe(true);
    for (const source of [
      "export default (",
      "console.log('No factory export');",
      "import missing from './missing.mjs'; export default missing;",
      "import x from 'unbundled-package'; export default x;",
    ])
      expect(
        (
          await tools.execute("create_extension", {
            files: { ...files, "index.mjs": source },
          })
        ).isError,
      ).toBe(true);
    expect(
      (
        await tools.execute("create_extension", {
          files: {
            ...files,
            "chisel-extension.json": JSON.stringify({
              ...manifest,
              id: "builtin.forbidden",
            }),
          },
        })
      ).isError,
    ).toBe(true);
    const macroMarker = join(directory, "unapproved-macro.txt");
    const macro = `import { writeFileSync } from 'node:fs' with { type: 'macro' }; export default writeFileSync(${JSON.stringify(macroMarker)}, 'unapproved execution');`;
    const macroResult = await tools.execute("create_extension", {
      files: { ...files, "index.mjs": macro },
    });
    expect(macroResult.isError).toBe(true);
    expect(macroResult.output).toContain("macros");
    expect(await Bun.file(macroMarker).exists()).toBe(false);
    expect(requests).toHaveLength(0);
    expect((await tools.execute("create_extension", { files })).isError).toBe(
      true,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.preview).toContain("без доверия");
    expect(await extensionRecords()).toEqual([]);
    session.mode = "plan";
    expect((await tools.execute("create_extension", { files })).isError).toBe(
      true,
    );
    expect(requests).toHaveLength(1);
    expect(await extensionRecords()).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real authoring execution installs immutable bytes disabled/untrusted, never evaluates code and preserves an existing package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-extension-author-"));
  const envName =
      process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME",
    previous = process.env[envName];
  process.env[envName] = directory;
  const gate = new ApprovalGate(
    config,
    { autoApprove: false, nonInteractive: false, allowedTools: new Set() },
    {
      async requestApproval() {
        return "approved";
      },
    },
  );
  const session = {
    id: "author",
    projectPath: directory,
    mode: "build",
    messages: [],
    provider: "anthropic",
    providerId: "anthropic",
    profileId: "fixture",
    model: "fixture",
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    totalCost: 0,
    undoStack: [],
    createdAt: "",
    updatedAt: "",
  } as Session;
  const tools = new ToolRegistry(directory, [], gate, session);
  try {
    const result = await tools.execute("create_extension", { files });
    expect(result.isError, result.output).not.toBe(true);
    expect(result.output).toContain("установлено выключенным");
    const records = await extensionRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.enabled).toBe(false);
    expect(records[0]?.approvedAt).toBeUndefined();
    expect((await inspectPackage(records[0]!.location)).manifest.kind).toBe(
      "ui",
    );
    expect(
      (globalThis as Record<string, unknown>).__chiselUnapprovedImport,
    ).toBeUndefined();
    expect(
      (
        await tools.execute("create_extension", {
          files: { ...files, "index.mjs": files["index.mjs"] + "\n// altered" },
        })
      ).isError,
    ).toBe(true);
    expect(await extensionRecords()).toEqual(records);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
