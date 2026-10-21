import { TextAttributes } from "@opentui/core";
import { createContext, useContext } from "react";
import type {
  UiColor,
  UiNativeProps,
  UiStyle,
} from "../extension-sdk/ui-composition.js";
import type { Palette } from "./appearance.js";

export const UiNativePresentation = createContext<UiNativeProps>({});
export const useUiNativePresentation = () => useContext(UiNativePresentation);
export function uiColor(palette: Palette, value?: UiColor) {
  return value?.startsWith("#")
    ? value
    : value
      ? (palette[value as keyof Palette] as string)
      : undefined;
}
export function uiBoxStyle(palette: Palette, style?: UiStyle) {
  if (!style) return {};
  return Object.fromEntries(
    Object.entries({
      width: style.width,
      height: style.height,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      padding: style.padding,
      gap: style.gap,
      flexGrow: style.grow,
      flexShrink: style.shrink,
      border: style.border,
      borderColor:
        style.border === false
          ? undefined
          : uiColor(palette, style.borderColor),
      borderStyle: style.border === false ? undefined : style.borderStyle,
      backgroundColor: uiColor(palette, style.bg),
      alignItems: style.align,
      justifyContent: style.justify,
    }).filter(([, value]) => value !== undefined),
  ) as {
    width?: number | `${number}%`;
    height?: number;
    minWidth?: number;
    maxWidth?: number;
    padding?: number;
    gap?: number;
    flexGrow?: number;
    flexShrink?: number;
    border?: boolean;
    borderColor?: string;
    borderStyle?: "single" | "double" | "rounded" | "heavy";
    backgroundColor?: string;
    alignItems?: UiStyle["align"];
    justifyContent?: UiStyle["justify"];
  };
}
export function uiTextStyle(palette: Palette, style?: UiStyle) {
  return {
    ...uiBoxStyle(palette, style),
    ...(style?.fg ? { fg: uiColor(palette, style.fg) } : {}),
    ...(style &&
    (style.bold !== undefined ||
      style.italic !== undefined ||
      style.dim !== undefined)
      ? {
          attributes:
            (style.bold ? TextAttributes.BOLD : 0) |
            (style.italic ? TextAttributes.ITALIC : 0) |
            (style.dim ? TextAttributes.DIM : 0),
        }
      : {}),
    ...(style?.wrap ? { wrapMode: style.wrap } : {}),
  };
}
