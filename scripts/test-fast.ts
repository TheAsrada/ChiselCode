import { fileURLToPath } from "node:url";

// Explicit, measured profile: no servers, child applications or OpenTUI renderer.
// Keep real process/filesystem/platform scenarios in test:full and Native validation.
const names = [
  "approval",
  "auto-compaction",
  "background-owner",
  "compatible-base-url",
  "context-usage",
  "conversation-source",
  "extension-commands",
  "extension-themes",
  "extension-tool-protocol",
  "extensions-context",
  "extensions-lifecycle",
  "file-diff",
  "fs-scan",
  "interactive-ui",
  "lsp-catalog",
  "mcp-sdk-client",
  "mcp-security",
  "model-summary-protocol",
  "network-environment",
  "network-retry",
  "onboarding",
  "prompt",
  "provider-capabilities",
  "provider-conformance",
  "provider-registry",
  "provider-settings",
  "provider-stream-events",
  "provider-tool-arguments",
  "release-ci",
  "skills",
  "subagent-output",
  "terminal-text",
  "tool-guidance",
  "tool-actions",
  "tui-controller",
  "tui-tab-execution",
  "tui-workspace",
  "update-controller",
  "web-compaction",
  "web-content",
  "web-security",
];

const child = Bun.spawn(
  [
    process.execPath,
    "test",
    ...names.map((name) => `./tests/unit/${name}.test.ts`),
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
