import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ForeignSession } from "./contracts.js";
import { file, filesUnder, json, missing, record, string } from "./files.js";
import { addText, date } from "./transcripts.js";

export interface OpenCodeSession {
  read(): Promise<ForeignSession | undefined>;
}
type SessionRow = {
  id: string;
  directory: string;
  title: string | null;
  time_created: number;
  time_updated: number;
  model?: string | null;
};
type MessageRow = { id: string; data: string; type?: string };
type PartRow = { message_id: string; data: string; type?: string };
type CredentialRow = { id: string; integration_id: string; value: string };

async function withDatabase<T>(path: string, action: (db: Database) => T) {
  try {
    if (!(await lstat(path)).isFile()) return;
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    return action(db);
  } finally {
    db.close();
  }
}
function hasTable(db: Database, name: string) {
  return !!db
    .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name);
}

function readSqlSession(db: Database, row: SessionRow, v2: boolean) {
  const session: ForeignSession = {
    id: row.id,
    path: row.directory,
    title: string(row.title),
    created: date(row.time_created),
    updated: date(row.time_updated),
    messages: [],
  };
  if (row.model) {
    const model = record(JSON.parse(row.model));
    session.provider = string(model.providerID);
    session.model = string(model.id);
  }
  const messages = db
    .query<MessageRow, [string]>(
      v2
        ? "SELECT id, type, substr(data, 1, 1000000) AS data FROM session_message WHERE session_id = ? ORDER BY seq LIMIT 10001"
        : "SELECT id, substr(data, 1, 1000000) AS data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 10001",
    )
    .iterate(row.id);
  const parts = db
    .query<PartRow, [string]>(
      v2
        ? "SELECT message_id, type, substr(data, 1, 1000000) AS data FROM session_part WHERE session_id = ? AND type = 'text' ORDER BY ordinal LIMIT 20001"
        : "SELECT message_id, substr(data, 1, 1000000) AS data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id LIMIT 20001",
    )
    .iterate(row.id);
  let bytes = 0;
  let count = 0;
  function checkRow(data: string, limit: number) {
    bytes += Buffer.byteLength(data);
    if (++count > limit || bytes > 32 * 1024 * 1024)
      throw new Error("Сессия превышает лимит импорта.");
  }
  const byMessage = new Map<string, unknown[]>();
  for (const part of parts) {
    checkRow(part.data, 20_000);
    const values = byMessage.get(part.message_id) ?? [];
    values.push({ type: part.type, ...record(JSON.parse(part.data)) });
    byMessage.set(part.message_id, values);
  }
  count = 0;
  for (const message of messages) {
    checkRow(message.data, 10_000);
    const data = record(JSON.parse(message.data));
    addOpenCodeMessage(session, data, message.type, byMessage.get(message.id));
  }
  return session.messages.length ? session : undefined;
}

function addOpenCodeMessage(
  session: ForeignSession,
  message: Record<string, unknown>,
  type?: string,
  parts?: unknown[],
) {
  const role = type ?? message.role;
  const model = record(message.model);
  if (role === "assistant") {
    session.model =
      string(model.id ?? model.modelID ?? message.modelID) ?? session.model;
    session.provider =
      string(model.providerID ?? message.providerID) ?? session.provider;
  }
  if (role === "user" && string(message.text))
    addText(session.messages, role, message.text);
  else addText(session.messages, role, parts ?? message.content);
}

export async function openCodeSessions(
  root: string,
): Promise<OpenCodeSession[]> {
  const dbPath = join(root, "opencode.db");
  const sql = await withDatabase(dbPath, (db) => {
    const v2 = hasTable(db, "session_v2");
    if (!v2 && !hasTable(db, "session")) return [];
    const table = v2 ? "session_v2" : "session";
    const rows = db
      .query<SessionRow, []>(
        `SELECT id, directory, title, time_created, time_updated${v2 ? ", model" : ""} FROM ${table} WHERE parent_id IS NULL ORDER BY time_updated, id LIMIT 50001`,
      )
      .all();
    if (rows.length > 50_000) throw new Error("Слишком много сессий.");
    return rows.map((row) => ({
      read: () => withDatabase(dbPath, (db) => readSqlSession(db, row, v2)),
    }));
  });
  if (sql?.length) return sql;
  const storage = join(root, "storage");
  const paths = await filesUnder(
    join(storage, "session"),
    (name) => name.endsWith(".json"),
    2,
  );
  return paths.map((path) => ({
    read: async () => {
      const metadata = await json(path);
      const id = basename(path, ".json");
      const cwd = string(metadata.directory);
      if (
        metadata.id !== id ||
        !/^ses_[\w-]+$/.test(id) ||
        !cwd ||
        metadata.parentID
      )
        return;
      const times = record(metadata.time);
      const session: ForeignSession = {
        id,
        path: cwd,
        title: string(metadata.title),
        created: date(times.created),
        updated: date(times.updated),
        messages: [],
      };
      const messages = await filesUnder(
        join(storage, "message", id),
        (name) => name.endsWith(".json"),
        0,
        10_000,
      );
      let remaining = 32 * 1024 * 1024;
      async function readRow(path: string) {
        const bytes = await file(path, Math.min(remaining, 2 * 1024 * 1024));
        remaining -= bytes.length;
        return record(JSON.parse(bytes.toString("utf8")));
      }
      const rows = [];
      for (const path of messages) rows.push(await readRow(path));
      rows.sort(
        (a, b) =>
          Number(record(a.time).created ?? 0) -
          Number(record(b.time).created ?? 0),
      );
      for (const message of rows) {
        const messageId = string(message.id);
        if (!messageId || !/^msg_[\w-]+$/.test(messageId)) continue;
        const paths = await filesUnder(
          join(storage, "part", messageId),
          (name) => name.endsWith(".json"),
          0,
          20_000,
        );
        const parts = [];
        for (const path of paths) parts.push(await readRow(path));
        addOpenCodeMessage(session, message, undefined, parts);
      }
      return session.messages.length ? session : undefined;
    },
  }));
}

export async function openCodeCredentials(root: string) {
  return (
    (await withDatabase(join(root, "opencode.db"), (db) => {
      if (!hasTable(db, "credential")) return [];
      return db
        .query<CredentialRow, []>(
          "SELECT id, integration_id, value FROM credential WHERE length(value) <= 8192 AND json_extract(value, '$.type') = 'key' ORDER BY integration_id, id LIMIT 256",
        )
        .all()
        .map((row) => ({
          id: row.id,
          provider: row.integration_id,
          key: string(record(JSON.parse(row.value)).key),
        }));
    })) ?? []
  );
}
