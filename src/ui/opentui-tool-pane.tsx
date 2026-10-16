/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import type { Palette } from "./appearance.js";
import { dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";

export function toolPaneLayout(
  width: number,
  height: number,
  embedded: boolean,
  maxHeight = 30,
  maxWidth = 104,
) {
  return embedded
    ? {
        popupWidth: width,
        popupHeight: height,
        innerWidth: width,
        roomy: height >= 18,
        tiny: height < 8 || width < 30,
      }
    : dialogLayout(width, height, maxHeight, maxWidth);
}

/** The same tool controller can live in Settings or in its command dialog. */
export function OpenTuiToolPane({
  embedded,
  children,
  ...props
}: {
  id: string;
  width: number;
  height: number;
  palette: Palette;
  onClose(): void;
  children: ReactNode;
  embedded?: boolean;
  maxHeight?: number;
  maxWidth?: number;
}) {
  return embedded ? (
    <box
      id={`${props.id}-panel`}
      width={props.width}
      height={props.height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      {children}
    </box>
  ) : (
    <OpenTuiDialog {...props}>{children}</OpenTuiDialog>
  );
}
