import type { ChatMessage, ToolImage } from "../types/domain.js";

const maxBytes = 256 * 1024;
const pngMagic = Buffer.of(137, 80, 78, 71, 13, 10, 26, 10);

/** A single request-local image. History, checkpoints and extension model hooks
 * receive only the original text result. */
export class ToolImageOutput {
  private pending?: { id: string; origin: string; image: ToolImage };

  constructor(
    private readonly permitted: (origin: string) => Promise<boolean>,
  ) {}

  async offer(id: string, origin: string, image: ToolImage) {
    if (
      image.mimeType !== "image/png" ||
      image.bytes.length < 24 ||
      image.bytes.length > maxBytes ||
      !Buffer.from(image.bytes.subarray(0, 8)).equals(pngMagic) ||
      !(await this.permitted(origin)) ||
      this.pending
    )
      return false;
    this.pending = { id, origin, image };
    return true;
  }

  async take(messages: readonly ChatMessage[]) {
    const pending = this.pending;
    this.pending = undefined;
    if (
      !pending ||
      !messages
        .at(-1)
        ?.content.some(
          (block) =>
            block.type === "tool_result" &&
            block.toolUseId === pending.id &&
            !block.isError,
        ) ||
      !(await this.permitted(pending.origin))
    )
      return undefined;
    return new Map([[pending.id, pending.image]]);
  }
}
