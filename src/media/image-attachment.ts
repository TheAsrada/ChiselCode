import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { chiselHomeDir } from "../paths/home.js";
import { replaceAtomicFile } from "../utils/atomic-file.js";

export const IMAGE_LIMIT = 4;
export const IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const IMAGE_PIXELS = 20_000_000;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const ImageAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(180),
  mimeType: z.enum(IMAGE_TYPES),
  width: z.int().positive(),
  height: z.int().positive(),
  size: z.int().positive().max(IMAGE_BYTES),
});
export type ImageAttachment = Readonly<z.infer<typeof ImageAttachmentSchema>>;

const directory = () => join(chiselHomeDir(), "attachments");
const stagedImages = new Set<string>();
const assetPath = (id: string) => join(directory(), z.uuid().parse(id));

async function boundedImage(path: string, limit: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Выберите обычный файл изображения.");
  if (info.size === 0 || info.size > limit)
    throw new Error("Файл пуст или превышает допустимый размер.");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== info.size)
      throw new Error("Файл изменился во время чтения.");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size)
      throw new Error("Файл изменился во время чтения.");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export async function importImage(
  source: string | Uint8Array,
  signal: AbortSignal,
): Promise<ImageAttachment> {
  signal.throwIfAborted();
  const bytes =
    typeof source === "string"
      ? await boundedImage(source, IMAGE_BYTES)
      : source;
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > IMAGE_BYTES)
    throw new Error("Изображение превышает 10 МиБ или пустое.");
  const { imageInfo } = await import("@opentui/core");
  let info: ReturnType<typeof imageInfo>;
  try {
    info = imageInfo(bytes);
  } catch {
    throw new Error(
      "Не удалось прочитать изображение. Выберите PNG, JPEG или WebP.",
    );
  }
  const mimeType = IMAGE_TYPES.find((type) => type === `image/${info.format}`);
  if (!mimeType) throw new Error("Выберите PNG, JPEG или WebP.");
  if (info.width * info.height > IMAGE_PIXELS)
    throw new Error("Изображение превышает 20 мегапикселей.");
  const name =
    typeof source === "string"
      ? basename(source)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames are rendered in the terminal.
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
          .trim()
          .slice(0, 180)
      : `Буфер обмена.${info.format === "jpeg" ? "jpg" : info.format}`;
  const image = {
    id: randomUUID(),
    name: name || "Изображение",
    mimeType,
    width: info.width,
    height: info.height,
    size: bytes.length,
  };
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const destination = assetPath(image.id);
  const temporary = `${destination}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx", signal });
    signal.throwIfAborted();
    await replaceAtomicFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  stagedImages.add(image.id);
  return image;
}

export async function readImage(image: ImageAttachment): Promise<Uint8Array> {
  const bytes = await boundedImage(assetPath(image.id), image.size);
  if (bytes.length !== image.size)
    throw new Error("Размер вложения изменился.");
  return bytes;
}

/** Publication may start in another async task before the user detaches a draft item. */
export function protectImages(images: readonly ImageAttachment[]): void {
  for (const image of images) stagedImages.delete(image.id);
}

export async function discardImage(image: ImageAttachment): Promise<void> {
  if (stagedImages.delete(image.id))
    await rm(assetPath(image.id), { force: true });
}

export function imageLabel(image: ImageAttachment): string {
  return `${image.name} · ${image.width}×${image.height}`;
}
