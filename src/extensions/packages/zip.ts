import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { cancelled } from "../../runtime/errors.js";
import { EXTENSION_MANIFEST, EXTERNAL_LIMITS } from "../external/manifest.js";
import { packageRelativePath } from "./paths.js";

const ZIP_LIMIT = 64 * 1024 * 1024,
  CHUNK = 64 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let n = value;
  for (let bit = 0; bit < 8; bit++)
    n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return crc >>> 0;
}
export function zipCrc32(bytes: Uint8Array): number {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
async function readAt(
  file: FileHandle,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (offset < 0 || length < 0 || length > 192 * 1024)
    throw new Error("Некорректная длина ZIP metadata.");
  const buffer = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    cancelled(signal);
    const read = await file.read(
      buffer,
      position,
      length - position,
      offset + position,
    );
    if (!read.bytesRead) throw new Error("ZIP обрезан.");
    position += read.bytesRead;
  }
  return buffer;
}
function extraFields(buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error("ZIP extra field обрезан.");
    const id = buffer.readUInt16LE(offset),
      length = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (
      offset + length > buffer.length ||
      id === 1 ||
      id === 0x7075 ||
      id === 0x6375 ||
      id === 0x9901 ||
      id === 0x756e ||
      id === 0x000d
    )
      throw new Error(
        "ZIP64, link metadata, неоднозначные encoding и encrypted ZIP не поддерживаются.",
      );
    offset += length;
  }
}
function filename(bytes: Buffer, flags: number): string {
  if (!(flags & 0x800) && bytes.some((byte) => byte > 127))
    throw new Error("ZIP filename encoding неоднозначен; используйте UTF-8.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
interface Entry {
  name: string;
  directory: boolean;
  rawName: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  data: number;
  end: number;
}
async function entries(
  file: FileHandle,
  signal: AbortSignal,
): Promise<Entry[]> {
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > ZIP_LIMIT ||
    stat.size < 22
  )
    throw new Error("ZIP не является ограниченным обычным файлом.");
  const tailOffset = Math.max(0, stat.size - 65557),
    tail = await readAt(file, tailOffset, stat.size - tailOffset, signal);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (
      tail.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + tail.readUInt16LE(i + 20) === tail.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("ZIP end record отсутствует или обрезан.");
  const count = tail.readUInt16LE(end + 10),
    centralSize = tail.readUInt32LE(end + 12),
    central = tail.readUInt32LE(end + 16);
  if (
    tail.readUInt16LE(end + 4) ||
    tail.readUInt16LE(end + 6) ||
    tail.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    central === 0xffffffff ||
    count > 2048 ||
    central + centralSize !== tailOffset + end
  )
    throw new Error(
      "Multi-disk/ZIP64/неверный central directory не поддерживается.",
    );
  const result: Entry[] = [],
    seen = new Map<string, { path: string; directory: boolean }>();
  let position = central,
    files = 0,
    expanded = 0;
  const claim = (name: string, directory: boolean, explicit: boolean) => {
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/"),
        key = path.normalize("NFC").toLowerCase(),
        dir = i < parts.length || directory,
        prior = seen.get(key);
      if (prior && (prior.path !== path || prior.directory !== dir))
        throw new Error("ZIP содержит case/type collision.");
      if (!prior) seen.set(key, { path, directory: dir });
    }
    if (seen.size > 2048) throw new Error("ZIP создаёт слишком много путей.");
    if (
      explicit &&
      result.some(
        (item) =>
          item.name.normalize("NFC").toLowerCase() ===
          name.normalize("NFC").toLowerCase(),
      )
    )
      throw new Error("ZIP содержит повторный entry.");
  };
  for (let i = 0; i < count; i++) {
    const header = await readAt(file, position, 46, signal);
    if (header.readUInt32LE(0) !== 0x02014b50)
      throw new Error("ZIP central signature повреждена.");
    const flags = header.readUInt16LE(8),
      method = header.readUInt16LE(10),
      crc = header.readUInt32LE(16),
      compressed = header.readUInt32LE(20),
      size = header.readUInt32LE(24),
      nameLength = header.readUInt16LE(28),
      extra = header.readUInt16LE(30),
      comment = header.readUInt16LE(32),
      disk = header.readUInt16LE(34),
      attributes = header.readUInt32LE(38),
      offset = header.readUInt32LE(42),
      needed = header.readUInt16LE(6);
    if (
      flags & ~0x80e ||
      (flags & 6 && method !== 8) ||
      ![0, 8].includes(method) ||
      disk ||
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      offset === 0xffffffff ||
      nameLength > 512 ||
      !nameLength ||
      needed > 20
    )
      throw new Error(
        "ZIP encryption/compression/flags/ZIP64 не поддерживаются.",
      );
    const variable = await readAt(
        file,
        position + 46,
        nameLength + extra + comment,
        signal,
      ),
      rawName = variable.subarray(0, nameLength),
      decoded = filename(rawName, flags),
      directory = decoded.endsWith("/"),
      name = packageRelativePath(decoded, directory);
    extraFields(variable.subarray(nameLength, nameLength + extra));
    const mode = attributes >>> 16,
      type = mode & 0xf000;
    if (
      (type && type !== (directory ? 0x4000 : 0x8000)) ||
      (attributes & 0x10 && !directory) ||
      attributes & 8 ||
      (directory && (size || crc || (method === 0 && compressed)))
    )
      throw new Error("ZIP link/device/directory attributes запрещены.");
    claim(name, directory, true);
    if (!directory) {
      files++;
      expanded += size;
      if (
        files > EXTERNAL_LIMITS.files ||
        expanded > EXTERNAL_LIMITS.bytes ||
        (name === EXTENSION_MANIFEST && size > EXTERNAL_LIMITS.manifest)
      )
        throw new Error("ZIP объявляет превышение limits.");
    }
    const local = await readAt(file, offset, 30, signal);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(4) !== needed ||
      local.readUInt16LE(6) !== flags ||
      local.readUInt16LE(8) !== method ||
      local.readUInt16LE(26) !== nameLength
    )
      throw new Error("ZIP central/local metadata не совпадает.");
    const localExtra = local.readUInt16LE(28),
      localVariable = await readAt(
        file,
        offset + 30,
        nameLength + localExtra,
        signal,
      );
    if (!localVariable.subarray(0, nameLength).equals(rawName))
      throw new Error("ZIP central/local names не совпадают.");
    extraFields(localVariable.subarray(nameLength));
    for (const [at, expected] of [
      [14, crc],
      [18, compressed],
      [22, size],
    ] as const)
      if (
        local.readUInt32LE(at) !== expected &&
        (!(flags & 8) || local.readUInt32LE(at) !== 0)
      )
        throw new Error("ZIP central/local sizes или CRC не совпадают.");
    const data = offset + 30 + nameLength + localExtra;
    let entryEnd = data + compressed;
    if (flags & 8) {
      const descriptor = await readAt(file, entryEnd, 16, signal),
        signature = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
      if (
        descriptor.readUInt32LE(signature) !== crc ||
        descriptor.readUInt32LE(signature + 4) !== compressed ||
        descriptor.readUInt32LE(signature + 8) !== size
      )
        throw new Error("ZIP data descriptor повреждён.");
      entryEnd += signature + 12;
    }
    if (entryEnd > central || offset >= central)
      throw new Error("ZIP entry пересекает central directory.");
    result.push({
      name,
      directory,
      rawName,
      flags,
      method,
      crc,
      compressed,
      size,
      offset,
      data,
      end: entryEnd,
    });
    position += 46 + nameLength + extra + comment;
  }
  if (position !== central + centralSize)
    throw new Error("ZIP central length не совпадает.");
  let boundary = 0;
  for (const entry of [...result].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== boundary)
      throw new Error("ZIP содержит overlap, gap или enclosing executable.");
    boundary = entry.end;
  }
  if (boundary !== central) throw new Error("ZIP содержит неописанные bytes.");
  if (
    !result.some(
      (entry) => !entry.directory && entry.name === EXTENSION_MANIFEST,
    )
  )
    throw new Error(
      `${EXTENSION_MANIFEST} должен лежать в корне ZIP. Уберите enclosing directory и перепакуйте.`,
    );
  return result;
}
export async function extractZip(
  source: string,
  destination: string,
  signal: AbortSignal,
  progress?: (value: { bytes: number; files: number }) => void,
): Promise<{ bytes: number; files: number }> {
  const file = await open(
    source,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let total = 0,
    files = 0;
  try {
    for (const entry of await entries(file, signal)) {
      cancelled(signal);
      const path = join(destination, entry.name);
      if (entry.directory) {
        await mkdir(path, { recursive: true, mode: 0o700 });
      } else await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const output = entry.directory
        ? undefined
        : await open(path, "wx", 0o600);
      let written = 0,
        crc = 0xffffffff;
      const limit = Math.min(
        EXTERNAL_LIMITS.bytes - total,
        entry.name === EXTENSION_MANIFEST
          ? EXTERNAL_LIMITS.manifest
          : EXTERNAL_LIMITS.bytes,
      );
      async function* chunks() {
        let offset = 0;
        while (offset < entry.compressed) {
          cancelled(signal);
          const count = Math.min(CHUNK, entry.compressed - offset),
            chunk = await readAt(file, entry.data + offset, count, signal);
          offset += count;
          yield chunk;
        }
      }
      const input = Readable.from(chunks(), {
        objectMode: false,
        highWaterMark: CHUNK,
      });
      const inflate =
        entry.method === 8
          ? createInflateRaw({ chunkSize: 16 * 1024 })
          : undefined;
      input.on("error", (error) => inflate?.destroy(error));
      const stream = inflate ? input.pipe(inflate) : input;
      const abort = () => {
        input.destroy(new Error("ZIP extraction отменён."));
        inflate?.destroy(new Error("ZIP extraction отменён."));
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for await (const value of stream) {
          cancelled(signal);
          const bytes = value as Buffer;
          written += bytes.length;
          if (
            written > limit ||
            written > entry.size ||
            total + bytes.length > EXTERNAL_LIMITS.bytes
          )
            throw new Error("ZIP decompression превышает actual byte limit.");
          crc = crcUpdate(crc, bytes);
          let offset = 0;
          while (offset < bytes.length) {
            cancelled(signal);
            offset += (
              await output!.write(bytes, offset, bytes.length - offset)
            ).bytesWritten;
          }
          total += bytes.length;
          progress?.({ bytes: total, files });
        }
        if (
          written !== entry.size ||
          (crc ^ 0xffffffff) >>> 0 !== entry.crc ||
          (inflate && inflate.bytesWritten !== entry.compressed)
        )
          throw new Error(
            "ZIP actual size, DEFLATE length или CRC не совпадает.",
          );
        await output?.sync();
        if (!entry.directory) files++;
        progress?.({ bytes: total, files });
      } finally {
        signal.removeEventListener("abort", abort);
        input.destroy();
        inflate?.destroy();
        await output?.close();
      }
    }
    return { bytes: total, files };
  } finally {
    await file.close();
  }
}
