/** @jsxImportSource @opentui/react */
import type { ScrollBoxProps } from "@opentui/react";

/** Shared native scrollbar defaults for the single OpenTUI appearance. */
export function TerminalScrollbox(props: ScrollBoxProps) {
  return (
    <scrollbox
      {...props}
      scrollbarOptions={{
        showArrows: false,
        ...props.scrollbarOptions,
        trackOptions: {
          visible: true,
          ...props.scrollbarOptions?.trackOptions,
        },
      }}
    />
  );
}
