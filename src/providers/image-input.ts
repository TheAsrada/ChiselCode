import { IMAGE_TOTAL_BYTES, readImage } from "../media/image-attachment.js";
import type { ChatMessage } from "../types/domain.js";

/** Only wire adapters materialize binary data. Keep newest photos within the request budget. */
export async function loadImageInputs(
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const images = new Map<string, string>();
  let size = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "image" || images.has(block.image.id)) continue;
      signal?.throwIfAborted();
      if (size + block.image.size > IMAGE_TOTAL_BYTES) continue;
      const bytes = await readImage(block.image).catch(() => undefined);
      if (!bytes) continue;
      size += bytes.length;
      images.set(block.image.id, Buffer.from(bytes).toString("base64"));
    }
  }
  signal?.throwIfAborted();
  return images;
}
