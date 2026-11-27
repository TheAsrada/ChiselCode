import {
  BoxRenderable,
  type CliRenderer,
  ImageRenderable,
  resolveImageRenderProtocol,
  TextRenderable,
} from "@opentui/core";
import stringWidth from "string-width";
import { imageLabel, readImage } from "../media/image-attachment.js";
import { DEFAULT_THEME, type Palette, THEMES } from "./appearance.js";
import { diffColors, diffPreviewText } from "./file-diff-preview.js";
import { terminalSafeText } from "./terminal-text.js";
import {
  actionFailed,
  actionReason,
  actionRunning,
  groupToolActions,
} from "./tool-actions.js";
import type {
  TranscriptEntry,
  TuiPresentationController as TuiController,
  TuiViewState,
} from "./tui-controller.js";

const COMMIT_BATCH = 64;

/** Keep completed messages in the terminal's main-screen history, above the live footer. */
export function attachTranscriptScrollback(
  controller: TuiController,
  renderer: Pick<
    CliRenderer,
    "writeToScrollback" | "resetSplitFooterForReplay"
  > &
    Partial<
      Pick<
        CliRenderer,
        | "createScrollbackSurface"
        | "capabilities"
        | "resolution"
        | "terminalHeight"
        | "footerHeight"
        | "isDestroyed"
      >
    >,
  palette: () => Palette = () => THEMES[DEFAULT_THEME],
): () => void {
  let lastId = -1;
  let previousCount = 0;
  let previousFirstId: number | undefined;
  let previousSession = controller.snapshot.sessionId;
  let initialized = false;

  let revision = 0;
  let attached = true;
  let drawing = false;
  let fallback: number | undefined;
  const update = (state: TuiViewState) => {
    if (renderer.isDestroyed) return;
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
      revision++;
    }
    initialized = true;
    previousSession = state.sessionId;
    previousCount = state.transcript.length;
    previousFirstId = state.transcript[0]?.id;
    if (drawing) return;

    const pending: TranscriptEntry[] = [];
    const rows = groupToolActions(state.transcript);
    for (const [index, entry] of rows.entries()) {
      const group = entry.actionGroup;
      const endId = group
        ? (state.transcript.find(
            (item) => item.toolAction?.id === group.items.at(-1)?.id,
          )?.id ?? entry.id)
        : entry.id;
      if (endId <= lastId) continue;
      if (
        group &&
        state.busy &&
        (group.items.some(actionRunning) || index === rows.length - 1)
      )
        break;
      const error = group?.items.find(actionFailed);
      pending.push(
        group
          ? {
              ...entry,
              id: endId,
              text: `${group.kind === "skills" ? "Навыки" : "Действия агента"} · ${group.items.length}\n${error ? actionReason(error) : group.kind === "skills" ? group.items.map((item) => String(item.input.name ?? item.name)).join(", ") : "Готово"}`,
              tone: error ? "error" : "tool",
            }
          : entry,
      );
    }
    const graphics =
      renderer.createScrollbackSurface &&
      resolveImageRenderProtocol(
        "auto",
        renderer.capabilities ?? null,
        !!renderer.resolution,
      ) !== "blocks";
    for (let index = 0; index < pending.length; ) {
      const entry = pending[index];
      if (graphics && entry?.images?.length && fallback !== entry.id) {
        const current = revision;
        drawing = true;
        void writePhotoScrollback(
          renderer,
          entry,
          palette(),
          () => attached && !renderer.isDestroyed && revision === current,
        )
          .then((written) => {
            if (revision !== current || !attached) return;
            if (written) lastId = entry.id;
            else fallback = entry.id;
          })
          .finally(() => {
            drawing = false;
            if (attached) update(controller.snapshot);
          });
        return;
      }
      const batch = pending.slice(index, index + COMMIT_BATCH);
      if (graphics) {
        const nextPhoto = batch.findIndex(
          (row, offset) => offset > 0 && row.images?.length,
        );
        if (nextPhoto > 0) batch.length = nextPhoto;
      }
      index += batch.length;
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
  };
  const detach = controller.subscribe(update);
  return () => {
    attached = false;
    detach();
  };
}

async function writePhotoScrollback(
  renderer: Partial<
    Pick<
      CliRenderer,
      "createScrollbackSurface" | "terminalHeight" | "footerHeight"
    >
  >,
  entry: TranscriptEntry,
  palette: Palette,
  current: () => boolean,
): Promise<boolean> {
  const first = entry.images?.[0];
  const available =
    (renderer.terminalHeight ?? 0) - (renderer.footerHeight ?? 0);
  if (!first || available < 7 || !renderer.createScrollbackSurface)
    return false;
  const bytes = await readImage(first).catch(() => undefined);
  if (!current() || !bytes) return false;
  let surface: ReturnType<CliRenderer["createScrollbackSurface"]> | undefined;
  try {
    surface = renderer.createScrollbackSurface({ startOnNewLine: true });
    const width = Math.min(surface.width, 52);
    const height = Math.min(
      7,
      available - 2,
      Math.max(3, Math.round((width * first.height) / first.width / 2)),
    );
    const captionWidth = Math.max(1, surface.width - 2);
    const text = entry.text
      ? scrollbackRows({ ...entry, images: undefined }, captionWidth)
      : [];
    const captions = scrollbackRows({ ...entry, text: "" }, captionWidth);
    if (text.length + captions.length + height > available) return false;
    const addText = (lines: string[]) => {
      if (lines.length)
        surface!.root.add(
          new TextRenderable(surface!.renderContext, {
            content: lines.join("\n"),
            width: surface!.width,
            height: lines.length,
            fg: palette.text,
          }),
        );
    };
    addText(text);
    const preview = new ImageRenderable(surface.renderContext, {
      source: bytes,
      width,
      height,
    });
    surface.root.add(preview);
    addText(captions);
    await preview.loadPromise;
    if (!preview.image || !current()) return false;
    surface.render();
    surface.commitRows(0, surface.height, { trailingNewline: true });
    return true;
  } catch {
    return false;
  } finally {
    surface?.destroy();
  }
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
  const content = terminalSafeText(
    [
      entry.text,
      ...(entry.images ?? []).map((image) => `Фото · ${imageLabel(image)}`),
    ]
      .filter(Boolean)
      .join("\n"),
    20_000,
  );
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
