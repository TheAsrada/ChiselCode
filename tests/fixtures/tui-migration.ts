import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import {
  loadGlobalConfig,
  loadProjectInstructions,
} from "../../src/config/load.js";
import { McpConfigStore } from "../../src/mcp/storage.js";
import { categoryIds, sourceIds } from "../../src/migration/contracts.js";
import { createMigrationActions } from "../../src/migration/service.js";
import {
  CredentialStore,
  credentialDirectory,
} from "../../src/security/credentials.js";
import { listSessions, saveSession } from "../../src/sessions/store.js";
import { loadSkills } from "../../src/skills/skills.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const base = await realpath(await mkdtemp(join(tmpdir(), "chisel-migration-")));
const home = join(base, "home");
const project = join(base, "Мой проект");
const data = join(base, "data");
const config = join(base, "config");
const configPath = join(config, "chiselcode", "config.json");
const capturePath = process.env.CHISEL_MIGRATION_FRAMES;
for (const [key, value] of Object.entries({
  HOME: home,
  USERPROFILE: home,
  APPDATA: config,
  LOCALAPPDATA: data,
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: data,
  CODEX_HOME: join(home, ".codex"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  OPENCODE_CONFIG_DIR: join(config, "opencode"),
}))
  process.env[key] = value;
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const fixtures = new Map<string, string>();
function put(relativePath: string, contents: string | object) {
  fixtures.set(
    join(base, relativePath),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}
function skill(relativePath: string, name: string) {
  put(
    `${relativePath}/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Use for a migration fixture.\n---\n# Imported skill\nRead [notes](references/notes.md).\n`,
  );
  put(`${relativePath}/${name}/references/notes.md`, "# Notes\n");
}
const timestamp = "2025-04-22T01:02:03.000Z";
const jsonl = (...events: object[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
put(
  "home/.claude/projects/project/chat.jsonl",
  jsonl(
    {
      type: "user",
      cwd: project,
      sessionId: "claude-id",
      timestamp,
      message: { content: "Claude conversation" },
    },
    {
      type: "assistant",
      cwd: project,
      sessionId: "claude-id",
      timestamp,
      message: {
        model: "claude-sonnet-5",
        content: [
          { type: "text", text: "Claude reply" },
          { type: "tool_use", name: "shell", input: {} },
        ],
      },
    },
  ),
);
put("home/.claude/CLAUDE.md", "Claude global instructions.");
put("home/.claude/settings.json", {
  env: { ANTHROPIC_API_KEY: "fixture-anthropic" },
});
put("home/.claude.json", {
  mcpServers: {
    docs: {
      type: "stdio",
      command: "migration-must-not-run",
      args: [],
      env: { TOKEN: "fixture-mcp" },
    },
  },
});
skill("home/.claude/skills", "claude-notes");

put(
  "home/.codex/sessions/2025/04/22/rollout.jsonl",
  jsonl(
    {
      type: "session_meta",
      timestamp,
      payload: { id: "codex-id", cwd: project },
    },
    { type: "turn_context", timestamp, payload: { model: "gpt-5" } },
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Codex conversation" }],
      },
    },
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>ignored</environment_context>",
          },
        ],
      },
    },
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Codex reply" }],
      },
    },
  ),
);
put(
  "home/.codex/archived_sessions/missing.jsonl",
  jsonl(
    {
      type: "session_meta",
      timestamp,
      payload: { id: "missing-id", cwd: join(base, "missing") },
    },
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Missing project" }],
      },
    },
  ),
);
put("home/.codex/AGENTS.md", "Codex global instructions.");
put("home/.codex/auth.json", {
  OPENAI_API_KEY: "fixture-openai",
  tokens: { access_token: "fixture-oauth" },
});
put(
  "home/.codex/config.toml",
  "model = 'gpt-5'\n[mcp_servers.search]\nurl = 'https://example.test/mcp'\nbearer_token_env_var = 'EXAMPLE_KEY'\n",
);
skill("home/.codex/skills", "codex-notes");

put("config/opencode/AGENTS.md", "OpenCode global instructions.");
put(
  "config/opencode/opencode.jsonc",
  `{
  // Global remote server
  "model": "openrouter/demo",
  "mcp": {"knowledge": {"type": "remote", "url": "https://example.test/tools", "headers": {"X-Token": "{env:EXAMPLE_KEY}"}}}
}`,
);
skill("config/opencode/skills", "opencode-notes");

await mkdir(project, { recursive: true });
for (const [path, contents] of fixtures) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
const dbPath = join(data, "opencode", "opencode.db");
await mkdir(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, model TEXT);
  CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
  CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, data TEXT);
  CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT);
`);
db.query(
  "INSERT INTO session_v2 VALUES ('ses_1', ?, 'OpenCode conversation', NULL, ?, ?, ?)",
).run(
  project,
  Date.parse(timestamp),
  Date.parse(timestamp),
  JSON.stringify({ id: "demo", providerID: "openrouter" }),
);
db.exec(`
  INSERT INTO session_message VALUES ('msg_user', 'ses_1', 'user', 1, '{"text":"OpenCode question"}');
  INSERT INTO session_message VALUES ('msg_reply', 'ses_1', 'assistant', 2, '{}');
  INSERT INTO session_part VALUES ('msg_reply', 'ses_1', 0, 'text', '{"text":"OpenCode reply"}');
  INSERT INTO credential VALUES ('cred_1', 'openrouter', '{"type":"key","key":"fixture-openrouter"}');
`);
db.close();

const ui = await createTestRenderer({
  width: 100,
  height: 29,
  exitOnCtrlC: false,
});
const frames: { time: number; frame: unknown }[] = [];
const origin = performance.now();
const capture = () => {
  if (capturePath) {
    const frame = ui.captureSpans();
    frames.push({
      time: performance.now() - origin,
      frame: {
        cols: frame.cols,
        rows: frame.rows,
        lines: frame.lines.map((line) =>
          line.spans.map((span) => ({
            text: span.text,
            width: span.width,
            attributes: span.attributes,
            fg: [span.fg.r, span.fg.g, span.fg.b, span.fg.a],
            bg: [span.bg.r, span.bg.g, span.bg.b, span.bg.a],
          })),
        ),
      },
    });
  }
};
async function ready(target: string, deadline = performance.now() + 5000) {
  do {
    await act(async () => {
      await Bun.sleep(capturePath ? 45 : 20);
      await ui.renderOnce();
    });
    capture();
    if (ui.captureCharFrame().includes(target)) return;
  } while (performance.now() < deadline);
  assert.fail(`Missing ${target}\n${ui.captureCharFrame()}`);
}
const app = runOpenTuiAgent(
  { configPath, externalExtensions: false, launcher: true },
  undefined,
  true,
  false,
  undefined,
  async () => ui.renderer,
);
try {
  await ready("Press any key");
  await act(async () => ui.mockInput.pressEnter());
  await ready("Импортировать · 16");
  if (capturePath) await act(async () => Bun.sleep(900));
  const started = performance.now();
  await act(async () => ui.mockInput.pressEnter());
  await ready("%");
  await ready("Перенос завершён", started + 6500);
  assert.ok(performance.now() - started >= 4900);
  await ready("3 добавлено · 1 пропущено");
  if (capturePath) await act(async () => Bun.sleep(1250));

  const sessions = await listSessions(project);
  assert.equal(sessions.length, 3);
  const claude = sessions.find(
    (session) => session.title === "Claude conversation",
  );
  assert.ok(claude);
  assert.equal(claude.updatedAt, timestamp);
  assert.equal(claude.messages[1]?.content[0]?.type, "text");
  assert.equal(claude.messages[1]?.content.length, 1);
  assert.equal(
    sessions.find((session) => session.title === "Codex conversation")?.messages
      .length,
    2,
  );
  assert.deepEqual(
    sessions
      .find((session) => session.title === "OpenCode conversation")
      ?.messages.flatMap((message) =>
        message.content.map((part) => part.type === "text" && part.text),
      ),
    ["OpenCode question", "OpenCode reply"],
  );

  const instructions = await loadProjectInstructions(project);
  for (const label of ["Claude", "Codex", "OpenCode"])
    assert.match(instructions, new RegExp(`${label} global instructions`));
  for (const name of ["claude-notes", "codex-notes", "opencode-notes"])
    assert.ok(loadSkills(project).some((item) => item.name === name));
  const store = new CredentialStore();
  const mcp = await new McpConfigStore(project, {
    globalPath: configPath,
  }).load();
  assert.equal(mcp.length, 3);
  assert.ok(mcp.every((entry) => !entry.config.enabled));
  const token = mcp.find((entry) => entry.config.label === "docs")?.config.env
    .TOKEN;
  assert.ok(token && "secretRef" in token);
  assert.equal(await store.get(token.secretRef), "fixture-mcp");
  const profiles = await loadGlobalConfig(configPath);
  assert.equal(profiles.defaultProfileId, undefined);
  assert.ok(
    sessions.every(
      (session) =>
        profiles.profiles[session.profileId]?.providerId === session.providerId,
    ),
  );
  const keys = await Promise.all(
    Object.values(profiles.profiles).map((profile) =>
      store.get(profile.apiKeyRef ?? ""),
    ),
  );
  assert.deepEqual(keys.sort(), [
    "fixture-anthropic",
    "fixture-openai",
    "fixture-openrouter",
  ]);
  for (const path of [
    configPath,
    join(credentialDirectory(), "credentials.enc"),
  ]) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /fixture-(?:anthropic|openai|openrouter|mcp|oauth)/,
    );
  }

  await act(async () => ui.mockInput.pressEnter());
  await ready("Claude Code · anthropic");
  await ready("Codex CLI · openai");
  if (capturePath) await Bun.write(capturePath, JSON.stringify(frames));
  await act(async () => ui.mockInput.pressEscape());
  await ready("ChiselCode");
  await act(async () => {
    await ui.mockInput.pasteBracketedText("/import");
    ui.mockInput.pressEnter();
  });
  await ready("Импортировать · 16");
  await act(async () => ui.resize(52, 15));
  await ready("Импортировать · 16");
  await act(async () => ui.mockInput.pressArrow("up"));
  await ready("Подключения и API-ключи");
  await act(async () => ui.mockInput.pressKey(" "));
  await ready("Импортировать · 13");
  await act(async () => ui.mockInput.pressEscape());

  claude.title = "Локальное название";
  await saveSession(claude);
  const core = createMigrationActions(configPath);
  const result = await core.run({
    categories: categoryIds,
    sources: sourceIds,
  });
  for (const category of categoryIds) {
    assert.equal(result.imported[category], 0);
    assert.equal(result.existing[category], 3);
    assert.equal(result.failed[category], 0);
  }
  assert.equal(result.skipped.sessions, 1);
  assert.ok(
    (await listSessions(project)).some(
      (session) => session.title === claude.title,
    ),
  );
  for (const [path, contents] of fixtures)
    assert.equal(await readFile(path, "utf8"), contents);
} finally {
  await act(async () => {
    process.emit("SIGTERM");
    await app;
  });
  await rm(base, { recursive: true, force: true });
}
