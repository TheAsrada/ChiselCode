import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ProcessCapture, ProcessStream } from "../processes/managed.js";
import { RuntimeError } from "../runtime/errors.js";
import { SecretRedactor } from "../security/redaction.js";

/** Terminal escapes are framed across writes; no OSC payload ever reaches disk. */
class TerminalFramer {
  private state: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
  push(text: string): string {
    let output = "";
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (this.state === "osc_escape") {
        this.state = ch === "\\" ? "text" : "osc";
        continue;
      }
      if (this.state === "osc") {
        if (code === 7 || code === 0x9c) this.state = "text";
        else if (code === 27) this.state = "osc_escape";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "escape") {
        this.state = ch === "]" ? "osc" : ch === "[" ? "csi" : "text";
        continue;
      }
      if (code === 27) {
        this.state = "escape";
        continue;
      }
      if (code === 0x9d) {
        this.state = "osc";
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        continue;
      }
      if (ch === "\r") output += "\n";
      else if (
        ch === "\n" ||
        ch === "\t" ||
        (code >= 32 && !(code >= 0x7f && code <= 0x9f))
      )
        output += ch;
    }
    return output;
  }
}

class SafeStream {
  private decoder = new StringDecoder("utf8");
  private terminal = new TerminalFramer();
  private pending = "";
  private dropping = false;
  private readonly secrets: readonly string[];
  constructor(private redactor: SecretRedactor) {
    this.secrets = redactor.knownValues();
    if (
      this.secrets.some((value) => value.length > 65536) ||
      this.secrets.length > 1024
    )
      throw new Error(
        "Слишком большой набор секретов для безопасного захвата вывода.",
      );
  }
  push(bytes: Uint8Array, flush = false): string {
    let delta = this.terminal.push(
      flush ? this.decoder.end() : this.decoder.write(Buffer.from(bytes)),
    );
    if (this.dropping) {
      const boundary = delta.search(/[\s,;"']/);
      if (boundary === -1) return "";
      this.dropping = false;
      delta = delta.slice(boundary);
    }
    this.pending += delta;
    let cut = flush
      ? this.pending.length
      : Math.max(
          this.pending.lastIndexOf("\n") + 1,
          this.pending.length -
            Math.max(512, ...this.secrets.map((s) => s.length)),
        );
    // Hold known values spanning any proposed boundary, including multiline keys.
    for (const secret of this.secrets) {
      let at = this.pending.indexOf(secret);
      while (at !== -1) {
        if (at < cut && at + secret.length > cut) cut = at;
        at = this.pending.indexOf(secret, at + 1);
      }
      if (!flush) {
        const tail = this.pending.slice(
          Math.max(0, cut - secret.length + 1),
          cut,
        );
        const sequence = `${secret}\u0000${tail}`;
        const prefix = new Uint32Array(sequence.length);
        for (let i = 1; i < sequence.length; i++) {
          let length = prefix[i - 1] ?? 0;
          while (length && sequence[i] !== sequence[length])
            length = prefix[length - 1] ?? 0;
          if (sequence[i] === sequence[length]) length++;
          prefix[i] = length;
        }
        const held = Math.min(secret.length - 1, prefix.at(-1) ?? 0);
        cut -= held;
      }
    }
    const sensitive =
      /\b(?:Bearer|Basic)\s+[^\s"',;]*|(?:api[-_]?key|password|secret|token|authorization)\s*[=:]\s*[^\s,;"']*|https?:\/\/[^\s<>"']*/gi;
    if (!flush)
      for (const match of this.pending.matchAll(sensitive))
        if (match.index < cut && match.index + match[0].length >= cut)
          cut = match.index;
    let output = this.redactor.text(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    if (this.pending.length > 131072) {
      output += "[длинное поле скрыто]";
      this.pending = "";
      this.dropping = true;
    }
    if (flush) {
      for (const secret of this.secrets)
        for (
          let size = Math.min(secret.length - 1, output.length);
          size > 0;
          size--
        )
          if (output.endsWith(secret.slice(0, size))) {
            output = `${output.slice(0, -size)}[секрет скрыт]`;
            break;
          }
    }
    return output;
  }
}

/** Two backpressured streams, one append sequence and bounded sanitization buffers. */
export class ProcessLog implements ProcessCapture {
  private file?: FileHandle;
  private pending = Promise.resolve();
  private readonly streams: Record<ProcessStream, SafeStream>;
  private closed = false;
  private incoming = 0;
  size = 0;
  truncated = false;
  constructor(
    readonly path: string,
    private limit: number,
    redactor: SecretRedactor,
    private readonly changed: (text: string, bytes: number) => void,
    private readonly overflow: () => void,
  ) {
    const safe = new SecretRedactor();
    for (const value of redactor.knownValues())
      safe.add(new TerminalFramer().push(value));
    this.streams = {
      stdout: new SafeStream(safe),
      stderr: new SafeStream(safe),
    };
  }
  narrowLimit(limit: number): void {
    if (limit > this.limit || limit < this.size)
      throw new Error("Уже сохранённый вывод превышает новый лимит.");
    this.limit = limit;
  }
  async create(): Promise<void> {
    this.file = await open(this.path, "wx", 0o600);
  }
  async write(stream: ProcessStream, bytes: Uint8Array): Promise<void> {
    if (this.closed) return;
    this.incoming += bytes.length;
    if (this.incoming > this.limit * 4) {
      this.truncated = true;
      this.overflow();
      return;
    }
    const text = this.streams[stream].push(bytes);
    await this.append(text);
  }
  private append(text: string): Promise<void> {
    if (!text) return this.pending;
    const operation = this.pending.then(async () => {
      if (!this.file) throw new Error("Вывод не открыт для записи.");
      let bytes: Buffer = Buffer.from(text);
      if (this.size + bytes.length > this.limit) {
        bytes = utf8Prefix(bytes, Math.max(0, this.limit - this.size));
        this.truncated = true;
        this.overflow();
      }
      if (!bytes.length) return;
      let offset = 0;
      while (offset < bytes.length)
        offset += (await this.file.write(bytes, offset, bytes.length - offset))
          .bytesWritten;
      this.size += bytes.length;
      this.changed(bytes.toString("utf8"), this.size);
    });
    this.pending = operation;
    return operation;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const stream of Object.values(this.streams))
        await this.append(stream.push(new Uint8Array(), true));
      await this.pending;
      await this.file?.sync();
    } finally {
      await this.file?.close();
    }
  }
  async read(
    cursor: number,
    limit: number,
  ): Promise<{ text: string; cursor: number; next: number }> {
    const info = await lstat(this.path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      (await realpath(this.path)) !== this.path
    )
      throw new RuntimeError(
        "PERMISSION_DENIED",
        "Путь сохранённого вывода изменился.",
      );
    const file = await open(
      this.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if ((await file.stat()).ino !== info.ino)
        throw new Error("Файл вывода подменён.");
      const start = Math.min(Math.max(0, Math.floor(cursor)), info.size);
      const bytes = Buffer.alloc(Math.min(limit + 4, info.size - start));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      let offset = 0;
      while (offset < bytesRead && (bytes[offset]! & 0xc0) === 0x80) offset++;
      const clean = utf8Prefix(bytes.subarray(offset, bytesRead), limit);
      return {
        text: clean.toString("utf8"),
        cursor: start + offset,
        next: start + offset + clean.length,
      };
    } finally {
      await file.close();
    }
  }
}
function utf8Prefix(bytes: Buffer, limit: number): Buffer {
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
