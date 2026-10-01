/** @jsxImportSource @opentui/react */
import type { BorderCharacters } from "@opentui/core";
import type { ScrollBoxProps } from "@opentui/react";
import { createContext, useContext } from "react";

/** Font coverage is not exposed by terminals: ASCII is the safe default. */
export const UnicodeDecorationContext = createContext(false);
export const ASCII_BORDER: BorderCharacters = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  topT: "+",
  bottomT: "+",
  leftT: "+",
  rightT: "+",
  cross: "+",
};
export function useTerminalDecoration() {
  const unicode = useContext(UnicodeDecorationContext);
  return { unicode, borderChars: unicode ? undefined : ASCII_BORDER };
}

/** OpenTUI's slider uses half-block glyphs; native ASCII arrows retain scrolling. */
export function TerminalScrollbox(props: ScrollBoxProps) {
  const { unicode } = useTerminalDecoration();
  return (
    <scrollbox
      {...props}
      scrollbarOptions={
        unicode
          ? {
              showArrows: false,
              ...props.scrollbarOptions,
              trackOptions: {
                visible: true,
                ...props.scrollbarOptions?.trackOptions,
              },
            }
          : {
              ...props.scrollbarOptions,
              showArrows: true,
              arrowOptions: {
                ...props.scrollbarOptions?.arrowOptions,
                arrowChars: { up: "^", down: "v", left: "<", right: ">" },
              },
              trackOptions: {
                ...props.scrollbarOptions?.trackOptions,
                visible: false,
              },
            }
      }
    />
  );
}
