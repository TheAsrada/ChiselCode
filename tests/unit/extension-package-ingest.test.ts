import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, Zip, ZipDeflate, zipSync } from "fflate";
import {
  extensionsDirectory,
  inspectPackage,
} from "../../src/extensions/external/package.js";
import { captureSource } from "../../src/extensions/packages/ingest.js";
import { extractZip } from "../../src/extensions/packages/zip.js";

const roots: string[] = [],
  keys = ["XDG_DATA_HOME", "LOCALAPPDATA"] as const,
  saved = keys.map((key) => process.env[key]);
afterEach(async () => {
  for (let i = 0; i < keys.length; i++) {
    if (saved[i] === undefined) delete process.env[keys[i]!];
    else process.env[keys[i]!] = saved[i];
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const files = {
  "chisel-extension.json": strToU8(
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture.install",
      version: "1.0.0",
      apiVersion: 1,
      entry: "index.mjs",
      displayName: "Пакет с цветами",
    }),
  ),
  "index.mjs": strToU8(
    "export default ({manifest}) => ({...manifest, activate(){}});",
  ),
  "assets/Русский.txt": strToU8("Проверяемые bytes\n".repeat(1000)),
};
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-package-ingest-")),
  );
  roots.push(root);
  for (const key of keys) process.env[key] = join(root, "Home");
  const source = join(root, "Внешняя папка"),
    store = await extensionsDirectory();
  await mkdir(source);
  for (const [name, value] of Object.entries(files)) {
    const target = join(source, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, value);
  }
  const staging = join(store, ".staging");
  await mkdir(staging);
  return { root, source, store, staging };
}
test("folder and streaming STORE/DEFLATE ZIP capture the same actual bytes and common digest", async () => {
  const f = await fixture();
  const directory = join(f.staging, "directory");
  await captureSource(
    f.source,
    directory,
    join(f.staging, "unused.zip"),
    new AbortController().signal,
  );
  const base = await inspectPackage(directory);
  for (const level of [0, 6] as const) {
    const archive = join(f.root, `${level}.zip`),
      destination = join(f.staging, `zip-${level}`);
    await writeFile(archive, zipSync(files, { level }));
    await captureSource(
      archive,
      destination,
      join(f.staging, `captured-${level}.zip`),
      new AbortController().signal,
    );
    expect((await inspectPackage(destination)).digest).toBe(base.digest);
    expect(
      await readFile(join(destination, "assets/Русский.txt"), "utf8"),
    ).toContain("Проверяемые bytes");
  }
});
test("archive paths/collisions/enclosing directories and symlink attributes are rejected without escape", async () => {
  const f = await fixture();
  let ordinal = 0;
  for (const name of [
    "../escape.txt",
    "/absolute",
    "C:/drive",
    "file:stream",
    "\\\\host\\share",
    "wrapper/chisel-extension.json",
  ]) {
    const archive = join(f.root, `bad-${ordinal}.zip`);
    await writeFile(archive, zipSync({ [name]: strToU8("bad") }));
    await expect(
      captureSource(
        archive,
        join(f.staging, `bad-${ordinal}`),
        join(f.staging, `copy-${ordinal++}.zip`),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  const archive = join(f.root, "collision.zip");
  await writeFile(
    archive,
    zipSync({
      ...files,
      "Case.txt": strToU8("one"),
      "case.txt": strToU8("two"),
    }),
  );
  await expect(
    captureSource(
      archive,
      join(f.staging, "collision"),
      join(f.staging, "collision-copy.zip"),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const linked = Buffer.from(zipSync(files));
  const central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  linked.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  await writeFile(join(f.root, "linked.zip"), linked);
  await expect(
    captureSource(
      join(f.root, "linked.zip"),
      join(f.staging, "linked"),
      join(f.staging, "linked-copy.zip"),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
test("CRC, metadata mismatch, encryption and truncation are detected before accepting an archive", async () => {
  const f = await fixture();
  const original = Buffer.from(zipSync(files));
  for (const kind of ["crc", "metadata", "encryption", "truncation"]) {
    let bad = Buffer.from(original);
    const central = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (kind === "crc") {
      bad.writeUInt32LE(123, central + 16);
      bad.writeUInt32LE(123, 14);
    }
    if (kind === "metadata") bad[central + 10] = 0;
    if (kind === "encryption") {
      bad[6] = 1;
      bad[central + 8] = 1;
    }
    if (kind === "truncation") bad = bad.subarray(0, bad.length - 1);
    const archive = join(f.root, `${kind}.zip`);
    await writeFile(archive, bad);
    await expect(
      captureSource(
        archive,
        join(f.staging, kind),
        join(f.staging, `${kind}-copy.zip`),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});
test("source links and recursive destination capture are rejected; cancel does not read code", async () => {
  const f = await fixture();
  await symlink(join(f.source, "index.mjs"), join(f.source, "linked.mjs"));
  await expect(
    captureSource(
      f.source,
      join(f.staging, "link"),
      join(f.staging, "link.zip"),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    captureSource(
      f.root,
      join(f.staging, "recursive"),
      join(f.staging, "recursive.zip"),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    captureSource(
      f.source,
      join(f.staging, "cancel"),
      join(f.staging, "cancel.zip"),
      abort.signal,
    ),
  ).rejects.toThrow();
});

test("streaming ZIP descriptors and deflated empty directories retain the common digest", async () => {
  const f = await fixture(),
    pieces: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    pieces.push(bytes);
  });
  for (const [name, bytes] of [
    ...Object.entries(files),
    ["empty/", new Uint8Array()],
  ] as [string, Uint8Array][]) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  const archive = join(f.root, "descriptors.zip"),
    destination = join(f.staging, "descriptors");
  await writeFile(archive, Buffer.concat(pieces));
  await captureSource(
    archive,
    destination,
    join(f.staging, "descriptor-copy.zip"),
    new AbortController().signal,
  );
  const base = join(f.staging, "base");
  await captureSource(
    f.source,
    base,
    join(f.staging, "unused.zip"),
    new AbortController().signal,
  );
  expect((await inspectPackage(destination)).digest).toBe(
    (await inspectPackage(base)).digest,
  );
});
test("actual inflate bounds reject false sizes and cancellation closes a partially written stream", async () => {
  const f = await fixture(),
    original = Buffer.from(
      zipSync(
        { ...files, "bomb.bin": new Uint8Array(4 * 1024 * 1024) },
        { level: 6 },
      ),
    );
  const falseSize = Buffer.from(original);
  let position = falseSize.readUInt32LE(falseSize.length - 6);
  while (position < falseSize.length - 22) {
    const length = falseSize.readUInt16LE(position + 28),
      name = falseSize
        .subarray(position + 46, position + 46 + length)
        .toString();
    if (name === "bomb.bin") {
      const local = falseSize.readUInt32LE(position + 42);
      falseSize.writeUInt32LE(1, position + 24);
      falseSize.writeUInt32LE(1, local + 22);
      break;
    }
    position +=
      46 +
      length +
      falseSize.readUInt16LE(position + 30) +
      falseSize.readUInt16LE(position + 32);
  }
  const bad = join(f.root, "false-size.zip"),
    target = join(f.staging, "false-size");
  await writeFile(bad, falseSize);
  await expect(
    captureSource(
      bad,
      target,
      join(f.staging, "false-size-copy.zip"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("actual byte limit");
  expect((await lstat(join(target, "bomb.bin"))).size).toBe(0);
  const actual = join(f.root, "cancel-stream.zip"),
    partial = join(f.staging, "partial"),
    stop = new AbortController();
  await writeFile(actual, original);
  await mkdir(partial);
  await expect(
    extractZip(actual, partial, stop.signal, (value) => {
      if (value.bytes > 64 * 1024) stop.abort();
    }),
  ).rejects.toThrow();
  expect((await lstat(join(partial, "bomb.bin"))).size).toBeLessThan(
    4 * 1024 * 1024,
  );
  await rm(partial, { recursive: true }); // Capture writer/pipes must no longer retain the file on Windows.
});
