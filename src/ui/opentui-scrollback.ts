import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import stringWidth from "string-width";
import { type Palette, THEMES } from "./appearance.js";
import { diffColors, diffPreviewText } from "./file-diff-preview.js";
import { terminalSafeText } from "./terminal-text.js";
import type { TranscriptEntry, TuiController } from "./tui-controller.js";

const COMMIT_BATCH = 64;

/** Keep completed messages in the terminal's main-screen history, above the live footer. */
export function attachTranscriptScrollback(
  controller: TuiController,
  renderer: Pick<
    CliRenderer,
    "writeToScrollback" | "resetSplitFooterForReplay"
  >,
  palette: () => Palette = () => THEMES.obsidian,
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
          if (entry.fileDiff) {
            const colors = diffColors(palette());
            const lines = diffPreviewText(
              entry.fileDiff,
              Math.max(1, width - 3),
            );
            const card = new BoxRenderable(renderContext, {
              width,
              height: lines.length,
              flexDirection: "column",
              marginTop: 1,
              paddingLeft: 1,
              paddingRight: 1,
              backgroundColor: palette().surface,
            });
            for (const [index, line] of lines.entries()) {
              const added = /^\s*\d*\s+\d+\s+\+ /.test(line);
              const removed = /^\s*\d+\s+\d*\s+- /.test(line);
              card.add(
                new TextRenderable(renderContext, {
                  content: line,
                  height: 1,
                  fg:
                    index === 0
                      ? palette().accent
                      : added || removed
                        ? palette().text
                        : palette().muted,
                  bg:
                    index === 0 || index === lines.length - 1
                      ? palette().raised
                      : added
                        ? colors.addedBg
                        : removed
                          ? colors.removedBg
                          : palette().surface,
                }),
              );
            }
            root.add(card);
            height += lines.length + 1;
            continue;
          }
          if (entry.tone === "context") {
            const [title = "", ...details] = entry.text.split("\n");
            const titleRows = scrollbackRows(
              { ...entry, text: title },
              Math.max(1, width - 3),
            );
            const detailRows = scrollbackRows(
              { ...entry, text: details.join("\n") },
              Math.max(1, width - 3),
            );
            const cardHeight = titleRows.length + detailRows.length;
            const card = new BoxRenderable(renderContext, {
              width,
              height: cardHeight,
              flexDirection: "row",
              backgroundColor: palette().surface,
            });
            card.add(
              new BoxRenderable(renderContext, {
                width: 1,
                height: cardHeight,
                backgroundColor: palette().accent,
              }),
            );
            const content = new BoxRenderable(renderContext, {
              width: Math.max(1, width - 1),
              height: cardHeight,
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
            });
            content.add(
              new TextRenderable(renderContext, {
                content: titleRows.join("\n"),
                height: titleRows.length,
                fg: palette().accent,
              }),
            );
            content.add(
              new TextRenderable(renderContext, {
                content: detailRows.join("\n"),
                height: detailRows.length,
                fg: palette().muted,
              }),
            );
            card.add(content);
            root.add(card);
            height += cardHeight;
            continue;
          }
          const lines = scrollbackRows(entry, Math.max(1, width - 2));
          root.add(
            new TextRenderable(renderContext, {
              content: lines.join("\n"),
              width,
              height: lines.length,
              fg: scrollbackColor(entry.tone, palette()),
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

function scrollbackColor(
  tone: TranscriptEntry["tone"],
  palette: Palette,
): string {
  switch (tone) {
    case "error":
      return palette.red;
    case "warn":
      return palette.yellow;
    case "success":
      return palette.green;
    case "user":
      return palette.text;
    case "logo":
    case "context":
      return palette.accent;
    case "tool":
    case "dim":
      return palette.muted;
    default:
      return palette.text;
  }
}

/** Use terminal cell widths so wide Unicode and wrapped lines have exact row counts. */
export function scrollbackRows(
  entry: TranscriptEntry,
  width: number,
): string[] {
  const diff = entry.fileDiff;
  if (diff) return diffPreviewText(diff, width);
  const content = terminalSafeText(entry.text, 20_000);
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
