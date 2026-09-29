import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import stringWidth from "string-width";
import { changedLinePreview, terminalSafeText } from "./opentui-transcript.js";
import type { TranscriptEntry, TuiController } from "./tui-controller.js";

const COMMIT_BATCH = 64;

/** Keep completed messages in the terminal's main-screen history, above the live footer. */
export function attachTranscriptScrollback(
  controller: TuiController,
  renderer: Pick<
    CliRenderer,
    "writeToScrollback" | "resetSplitFooterForReplay"
  >,
): () => void {
  let lastId = -1;
  let previousCount = 0;
  let previousFirstId: number | undefined;
  let previousSession = controller.snapshot.sessionId;
  let initialized = false;

  return controller.subscribe((state) => {
    if (
      initialized &&
      ((previousSession !== undefined && state.sessionId !== previousSession) ||
        (previousCount > 0 && state.transcript.length === 0) ||
        (previousFirstId !== undefined &&
          state.transcript[0] !== undefined &&
          state.transcript[0].id !== previousFirstId))
    ) {
      renderer.resetSplitFooterForReplay();
      lastId = -1;
    }
    initialized = true;
    previousSession = state.sessionId;
    previousCount = state.transcript.length;
    previousFirstId = state.transcript[0]?.id;

    const pending: TranscriptEntry[] = [];
    for (let index = state.transcript.length - 1; index >= 0; index--) {
      const entry = state.transcript[index];
      if (!entry || entry.id <= lastId) break;
      pending.push(entry);
    }
    pending.reverse();
    for (let index = 0; index < pending.length; index += COMMIT_BATCH) {
      const batch = pending.slice(index, index + COMMIT_BATCH);
      renderer.writeToScrollback(({ width, renderContext }) => {
        const root = new BoxRenderable(renderContext, {
          width,
          flexDirection: "column",
          shouldFill: false,
        });
        let height = 0;
        for (const entry of batch) {
          const lines = scrollbackRows(entry, Math.max(1, width - 2));
          root.add(
            new TextRenderable(renderContext, {
              content: lines.join("\n"),
              width,
              height: lines.length,
              fg: scrollbackColor(entry.tone),
            }),
          );
          height += lines.length;
        }
        root.height = height;
        return {
          root,
          width,
          height,
          startOnNewLine: true,
          trailingNewline: true,
        };
      });
      lastId = batch.at(-1)?.id ?? lastId;
    }
  });
}

function scrollbackColor(tone: TranscriptEntry["tone"]): string {
  switch (tone) {
    case "error":
      return "#e98484";
    case "warn":
      return "#e5bf74";
    case "success":
      return "#88c89b";
    case "user":
      return "#f0f3f7";
    default:
      return "#d6dce5";
  }
}

/** Use terminal cell widths so wide Unicode and wrapped lines have exact row counts. */
export function scrollbackRows(
  entry: TranscriptEntry,
  width: number,
): string[] {
  const diff = entry.fileDiff;
  const content = diff
    ? `${terminalSafeText(diff.path, 180)} · +${diff.additions} −${diff.deletions}\n${changedLinePreview(diff).join("\n")}`
    : terminalSafeText(entry.text, 20_000);
  const rows: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const line of content.split("\n")) {
    let row = "";
    let columns = 0;
    for (const { segment } of segmenter.segment(line)) {
      const cells = stringWidth(segment);
      if (columns + cells > width && row) {
        rows.push(row);
        row = "";
        columns = 0;
      }
      if (cells > width) continue;
      row += segment;
      columns += cells;
    }
    rows.push(row);
  }
  return rows;
}
