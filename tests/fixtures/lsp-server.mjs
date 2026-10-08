// Deterministic protocol/race peer only. Acceptance uses the real installed server.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const control = () => JSON.parse(readFileSync(join(root, "peer.json"), "utf8"));
const log = (entry) =>
  appendFileSync(join(root, "peer.log"), `${JSON.stringify(entry)}\n`);
let buffer = Buffer.alloc(0);
const documents = new Map();
const encode = (value) => {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value }));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`),
    bytes,
  ]);
};
let output = Promise.resolve();
const send = (value, fragmented = false) => {
  output = output.then(async () => {
    const bytes = encode(value);
    if (fragmented) {
      process.stdout.write(bytes.subarray(0, 8));
      await new Promise((resolve) => setTimeout(resolve, 2));
      process.stdout.write(bytes.subarray(8, 41));
      process.stdout.write(bytes.subarray(41));
    } else process.stdout.write(bytes);
  });
};
const notify = (method, params) => send({ method, params });
const diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1,
  code: 999,
  message: "fixture error",
};
const publish = (doc) => {
  const settings = control();
  if (settings.noDiagnostics) return;
  if (settings.provisional)
    notify("textDocument/publishDiagnostics", {
      uri: doc.uri,
      diagnostics: [],
    });
  const version = doc.version;
  const uri = settings.encodedUri
    ? doc.uri
        .replace(/main\.ts$/, "m%61in.ts")
        .replace(
          /^file:\/\/\/([A-Z]):/,
          (_, drive) => `file:///${drive.toLowerCase()}%3A`,
        )
    : doc.uri;
  setTimeout(
    () =>
      notify("textDocument/publishDiagnostics", {
        uri,
        ...(settings.unversioned
          ? {}
          : { version: settings.oldVersion ? version - 1 : version }),
        diagnostics: doc.text.includes("error")
          ? Array.from({ length: settings.diagnosticCount ?? 1 }, () => ({
              ...diagnostic,
              message: settings.message ?? diagnostic.message,
            }))
          : [],
      }),
    settings.diagnosticsDelay ?? 5,
  );
};
async function receive(message) {
  log(message);
  const { id, method, params } = message;
  const settings = control();
  if (method === "initialize") {
    setTimeout(
      () =>
        send(
          {
            id,
            result: {
              capabilities: {
                positionEncoding: settings.encoding ?? "utf-16",
                textDocumentSync: {
                  openClose: true,
                  change: settings.sync ?? 2,
                  save: { includeText: true },
                },
                definitionProvider: !settings.unsupported,
                referencesProvider: true,
                documentSymbolProvider: true,
              },
            },
          },
          true,
        ),
      settings.initializeDelay ?? 0,
    );
    return;
  }
  if (method === "initialized") {
    if (settings.children) {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      writeFileSync(
        join(root, "peer-pids.json"),
        JSON.stringify([process.pid, child.pid]),
      );
    }
    return;
  }
  if (method === "shutdown") {
    if (!settings.ignoreShutdown) send({ id, result: null });
    return;
  }
  if (method === "exit") return process.exit(0);
  if (method === "textDocument/didOpen") {
    const doc = params.textDocument;
    documents.set(doc.uri, doc);
    publish(doc);
    return;
  }
  if (method === "textDocument/didChange") {
    const doc = documents.get(params.textDocument.uri);
    Object.assign(doc, params.textDocument, {
      text: params.contentChanges[0].text,
    });
    publish(doc);
    return;
  }
  if (method === "textDocument/didClose") {
    documents.delete(params.textDocument.uri);
    return;
  }
  if (method === "fixture/echo")
    return send(
      {
        id,
        result:
          Array.isArray(params) && params.length === 1 ? params[0] : params,
      },
      true,
    );
  if (method === "fixture/env") return send({ id, result: process.env });
  if (method === "fixture/hang") return;
  if (method === "fixture/delay")
    return setTimeout(() => send({ id, result: "late" }), 60);
  if (method === "fixture/serverRequests") {
    process.stdout.write(
      Buffer.concat([
        encode({
          id: "server-config",
          method: "workspace/configuration",
          params: { items: [{ section: "credentials" }] },
        }),
        encode({
          id: "server-edit",
          method: "workspace/applyEdit",
          params: { edit: { changes: {} } },
        }),
        encode({
          id: "server-unknown",
          method: "window/showDocument",
          params: { uri: "https://unsafe.example" },
        }),
        encode({ id, result: true }),
      ]),
    );
    return;
  }
  if (method === "fixture/oversize")
    return process.stdout.write("Content-Length: 99999999\r\n\r\n");
  if (method === "fixture/malformed")
    return process.stdout.write("Content-Length: 3\r\n\r\nbad");
  if (method === "fixture/EOF")
    // A clean process exit mid-frame provides actual EOF on Windows pipes too.
    return process.stdout.write('Content-Length: 20\r\n\r\n{"id":', () =>
      process.exit(0),
    );
  if (method === "fixture/crash") return process.exit(2);
  if (
    method === "textDocument/definition" ||
    method === "textDocument/references" ||
    method === "textDocument/documentSymbol"
  ) {
    const range = diagnostic.range;
    const result = method.endsWith("documentSymbol")
      ? "symbols" in settings
        ? settings.symbols
        : settings.nullSymbols
          ? null
          : [
              {
                name: "parent",
                kind: 12,
                range,
                selectionRange: range,
                children: [
                  { name: "nested", kind: 13, range, selectionRange: range },
                ],
              },
            ]
      : "locations" in settings
        ? settings.locations
        : [{ uri: params.textDocument.uri, range }];
    return setTimeout(
      () =>
        send(
          settings.requestError
            ? { id, error: { code: -32000, message: "token=internal-secret" } }
            : { id, result },
        ),
      settings.requestDelay ?? 0,
    );
  }
  if (id !== undefined && method)
    send({ id, error: { code: -32601, message: "Unknown fixture method" } });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(
      /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1],
    );
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    receive(message).catch(() => process.exit(3));
  }
});
process.stdin.on("end", () => process.exit(0));
