/** @jsxImportSource @opentui/react */

import {
  type BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  NativeImage,
  resolveImageRenderProtocol,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ImageAttachment,
  imageLabel,
  readImage,
} from "../media/image-attachment.js";
import type { Palette } from "./appearance.js";
import { dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { isCtrlC } from "./terminal-keys.js";
import { terminalLine } from "./terminal-text.js";

type Viewport = React.RefObject<ScrollBoxRenderable | null>;
const observers = new WeakMap<
  CliRenderer,
  { callbacks: Set<() => void>; notify(): void }
>();

function observeFrame(renderer: CliRenderer, callback: () => void): () => void {
  let observer = observers.get(renderer);
  if (!observer) {
    const callbacks = new Set<() => void>();
    observer = {
      callbacks,
      notify: () => {
        for (const notify of callbacks) notify();
      },
    };
    observers.set(renderer, observer);
    renderer.on(CliRenderEvents.FRAME, observer.notify);
  }
  const { callbacks, notify } = observer;
  callbacks.add(callback);
  return () => {
    callbacks.delete(callback);
    if (callbacks.size) return;
    renderer.off(CliRenderEvents.FRAME, notify);
    observers.delete(renderer);
  };
}

export function usePhotoGraphics(): boolean {
  const renderer = useRenderer();
  const read = useCallback(
    () =>
      resolveImageRenderProtocol(
        "auto",
        renderer.capabilities,
        !!renderer.resolution,
      ) !== "blocks",
    [renderer],
  );
  const [graphics, setGraphics] = useState(read);
  useEffect(() => {
    const refresh = () => setGraphics(read());
    renderer.on(CliRenderEvents.CAPABILITIES, refresh);
    const detach = observeFrame(renderer, refresh);
    refresh();
    return () => {
      renderer.off(CliRenderEvents.CAPABILITIES, refresh);
      detach();
    };
  }, [renderer, read]);
  return graphics;
}

function PhotoImage({
  image,
  width,
  height,
  palette,
  viewport,
}: {
  image: ImageAttachment;
  width: number;
  height: number;
  palette: Palette;
  viewport?: Viewport;
}) {
  const renderer = useRenderer();
  const reference = useRef<BoxRenderable>(null);
  const [visible, setVisible] = useState(!viewport);
  const [preview, setPreview] = useState<NativeImage>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!viewport) return;
    let previous = false;
    const measure = () => {
      const box = reference.current;
      const clip = viewport.current?.viewport;
      const next =
        !!box &&
        !!clip &&
        box.screenY + box.height > clip.screenY &&
        box.screenY < clip.screenY + clip.height;
      if (previous !== next) {
        previous = next;
        setVisible(next);
      }
    };
    measure();
    return observeFrame(renderer, measure);
  }, [renderer, viewport]);

  useEffect(() => {
    setPreview(undefined);
    setFailed(false);
    if (!visible) return;
    let active = true;
    let rendered: NativeImage | undefined;
    void readImage(image)
      .then((source) => {
        if (!active) return;
        const original = NativeImage.decode(source);
        try {
          const cellWidth = renderer.resolution
            ? renderer.resolution.width / renderer.terminalWidth
            : 12;
          const cellHeight = renderer.resolution
            ? renderer.resolution.height / renderer.terminalHeight
            : 24;
          const scale = Math.min(
            1,
            (width * cellWidth) / original.width,
            (height * cellHeight) / original.height,
          );
          rendered =
            scale === 1
              ? original.retain()
              : original.resize({
                  width: Math.max(1, Math.round(original.width * scale)),
                  height: Math.max(1, Math.round(original.height * scale)),
                });
          setPreview(rendered);
        } finally {
          original.dispose();
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      rendered?.dispose();
    };
  }, [image, visible, renderer, width, height]);

  return (
    <box
      ref={reference}
      width={width}
      height={height}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={palette.surface}
    >
      {failed ? (
        <text fg={palette.muted}>{terminalLine("Фото недоступно", width)}</text>
      ) : visible && preview ? (
        <image
          id={`photo-preview-${image.id}`}
          source={preview}
          width={width}
          height={height}
          fit="fit"
          onError={() => setFailed(true)}
        />
      ) : null}
    </box>
  );
}

function PhotoButton({
  id,
  label,
  palette,
  onPress,
  focused,
}: {
  id?: string;
  label: string;
  palette: Palette;
  onPress(): void;
  focused?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: F10, Tab and Enter provide keyboard access to photo actions.
    <text
      id={id}
      height={1}
      selectable={false}
      fg={palette.accent}
      bg={focused ? palette.raised : undefined}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        onPress();
      }}
    >
      {label}
    </text>
  );
}

export function AddPhotoButton({
  compact,
  palette,
  onPress,
}: {
  compact: boolean;
  palette: Palette;
  onPress(): void;
}) {
  return (
    <PhotoButton
      id="photo-attach"
      label={compact ? "Фото" : "Фото · F10"}
      palette={palette}
      onPress={onPress}
    />
  );
}

export function DraftPhotos({
  images,
  width,
  height,
  palette,
  pending,
  error,
  onOpen,
  onRemove,
}: {
  images: readonly ImageAttachment[];
  width: number;
  height: number;
  palette: Palette;
  pending: boolean;
  error?: string;
  onOpen(index: number): void;
  onRemove(id: string): void;
}) {
  const graphics = usePhotoGraphics();
  if (!images.length && !pending && !error) return null;
  const compact = width < 54 || height < 20;
  const shown = compact
    ? 0
    : Math.min(images.length, Math.max(1, Math.floor((width - 3) / 23)));
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {(images.length > 0 || pending) && (
        <text fg={palette.muted} height={1} paddingLeft={1}>
          {terminalLine(
            pending ? "Читаю фото…" : `${images.length} прикреплено`,
            Math.max(1, width - 1),
          )}
        </text>
      )}
      {shown > 0 && (
        <box flexDirection="row" gap={1} paddingLeft={1} marginBottom={1}>
          {images.slice(0, shown).map((image, index) => (
            <box
              key={image.id}
              width={22}
              flexShrink={0}
              backgroundColor={palette.raised}
            >
              {graphics && (
                <PhotoImage
                  image={image}
                  width={22}
                  height={4}
                  palette={palette}
                />
              )}
              <box
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
              >
                <PhotoButton
                  label={terminalLine(image.name, 17)}
                  palette={palette}
                  onPress={() => onOpen(index)}
                />
                <PhotoButton
                  label="×"
                  palette={palette}
                  onPress={() => onRemove(image.id)}
                />
              </box>
            </box>
          ))}
          {width >= shown * 23 + 9 && images.length > shown && (
            <PhotoButton
              label={`Ещё ${images.length - shown}`}
              palette={palette}
              onPress={() => onOpen(shown)}
            />
          )}
        </box>
      )}
      {error && (
        <text id="photo-error" height={1} fg={palette.red}>
          {terminalLine(error, width)}
        </text>
      )}
    </box>
  );
}

export function MessagePhotos({
  id,
  images,
  width,
  palette,
  focus,
  onOpen,
  viewport,
  graphics,
}: {
  id: string;
  images: readonly ImageAttachment[];
  width: number;
  palette: Palette;
  focus?: boolean;
  onOpen(index: number): void;
  viewport?: Viewport;
  graphics: boolean;
}) {
  const count = images.length > 1 && width >= 62 ? 2 : 1;
  const cellWidth = Math.max(
    1,
    Math.min(
      count === 1 ? 54 : 38,
      Math.floor((width - (count - 1)) / Math.min(count, images.length)),
    ),
  );
  return (
    <box flexDirection="column" marginBottom={1} gap={0}>
      <box flexDirection="row" gap={1}>
        {images.slice(0, count).map((image, index) => (
          <box
            key={image.id}
            width={cellWidth}
            backgroundColor={palette.raised}
            flexShrink={0}
          >
            {graphics && width >= 28 && (
              <PhotoImage
                image={image}
                width={cellWidth}
                height={Math.max(
                  3,
                  Math.min(
                    10,
                    Math.round((cellWidth * image.height) / image.width / 2),
                  ),
                )}
                palette={palette}
                viewport={viewport}
              />
            )}
            <PhotoButton
              id={index === 0 ? id : undefined}
              palette={palette}
              focused={!index && focus}
              label={terminalLine(
                `${index === 0 && focus ? "› " : ""}${imageLabel(image)}`,
                cellWidth,
              )}
              onPress={() => onOpen(index)}
            />
          </box>
        ))}
      </box>
      {images.length > count && (
        <PhotoButton
          label={`Ещё ${images.length - count}`}
          palette={palette}
          onPress={() => onOpen(count)}
        />
      )}
    </box>
  );
}

export function PhotosDialog({
  width,
  height,
  palette,
  images,
  index,
  active,
  error,
  pending,
  onClose,
  onSelect,
  onRemove,
  onFile,
  onClipboard,
}: {
  width: number;
  height: number;
  palette: Palette;
  images: readonly ImageAttachment[];
  index?: number;
  active: boolean;
  error?: string;
  pending: boolean;
  onClose(): void;
  onSelect(index: number | undefined): void;
  onRemove?(id: string): void;
  onFile?(path: string): void;
  onClipboard?(): void;
}) {
  const graphics = usePhotoGraphics();
  const [path, setPath] = useState("");
  const [selection, setSelection] = useState(-1);
  const managing = index === undefined;
  const photo = index === undefined ? undefined : images[index];
  const maxHeight = managing ? 13 : graphics ? 38 : 8;
  const maxWidth = managing || !graphics ? 72 : 110;
  const layout = dialogLayout(width, height, maxHeight, maxWidth);
  const handleEscape = () => {
    if (!managing && onFile) onSelect(undefined);
    else onClose();
  };
  const step = (offset: number) => {
    if (index !== undefined && images.length)
      onSelect((index + offset + images.length) % images.length);
  };
  useUiKeyboard((event) => {
    if (!active || capturedInputOwner(event) !== "photos") return;
    if (event.name === "escape" || isCtrlC(event)) handleEscape();
    else if (!managing && event.name === "left") step(-1);
    else if (!managing && event.name === "right") step(1);
    else if (managing && event.name === "tab" && images.length)
      setSelection((value) => (value < 0 ? 0 : -1));
    else if (managing && selection >= 0 && event.name === "up")
      setSelection(Math.max(0, selection - 1));
    else if (managing && selection >= 0 && event.name === "down")
      setSelection(Math.min(images.length - 1, selection + 1));
    else if (
      managing &&
      selection >= 0 &&
      event.name === "return" &&
      images[selection]
    )
      onSelect(selection);
    else if (
      managing &&
      selection >= 0 &&
      event.name === "delete" &&
      images[selection]
    ) {
      onRemove?.(images[selection].id);
      setSelection(Math.min(selection, images.length - 2));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  return (
    <OpenTuiDialog
      id="photos"
      width={width}
      height={height}
      maxHeight={maxHeight}
      maxWidth={maxWidth}
      palette={palette}
      onClose={handleEscape}
    >
      <text fg={palette.text} height={1}>
        {terminalLine(
          managing
            ? "Прикрепить фото"
            : `Фото ${(index ?? 0) + 1}/${images.length} · ${photo ? imageLabel(photo) : ""}`,
          layout.innerWidth,
        )}
      </text>
      {managing ? (
        <>
          <input
            id="photo-path"
            focused={active && selection < 0}
            value={path}
            backgroundColor={palette.raised}
            textColor={palette.text}
            focusedTextColor={palette.text}
            placeholder="Путь к PNG, JPEG или WebP"
            placeholderColor={palette.muted}
            onInput={setPath}
            onSubmit={() => {
              if (path.trim() && !pending) onFile?.(path.trim());
            }}
          />
          <PhotoButton
            label={terminalLine("Из буфера", layout.innerWidth)}
            palette={palette}
            onPress={() => onClipboard?.()}
          />
          {images.map((image, position) => (
            <box key={image.id} flexDirection="row" gap={1} height={1}>
              <PhotoButton
                label={terminalLine(
                  `${selection === position ? "› " : "  "}${imageLabel(image)}`,
                  Math.max(1, layout.innerWidth - 3),
                )}
                palette={palette}
                focused={selection === position}
                onPress={() => onSelect(position)}
              />
              <PhotoButton
                label="×"
                palette={palette}
                onPress={() => onRemove?.(image.id)}
              />
            </box>
          ))}
          <text fg={error ? palette.red : palette.muted} height={1}>
            {terminalLine(
              error ??
                (pending
                  ? "Читаю фото…"
                  : "Enter добавить · Tab список · Esc закрыть"),
              layout.innerWidth,
            )}
          </text>
        </>
      ) : (
        <>
          {photo && graphics && layout.popupHeight >= 6 && (
            <PhotoImage
              key={photo.id}
              image={photo}
              width={layout.innerWidth}
              height={Math.max(1, layout.popupHeight - (layout.roomy ? 6 : 4))}
              palette={palette}
            />
          )}
          {photo && !graphics && (
            <text fg={palette.muted} height={1}>
              {terminalLine(
                "Терминал показывает текстовую карточку",
                layout.innerWidth,
              )}
            </text>
          )}
          <box flexDirection="row" gap={2} height={1}>
            {images.length > 1 && (
              <PhotoButton
                label="‹"
                palette={palette}
                onPress={() => step(-1)}
              />
            )}
            {images.length > 1 && (
              <PhotoButton
                label="›"
                palette={palette}
                onPress={() => step(1)}
              />
            )}
            <PhotoButton
              label="Закрыть · Esc"
              palette={palette}
              onPress={handleEscape}
            />
          </box>
        </>
      )}
    </OpenTuiDialog>
  );
}
