/** @jsxImportSource @opentui/react */

import { LinearScrollAccel, MacOSScrollAccel } from "@opentui/core";
import type { ScrollBoxProps } from "@opentui/react";
import { useMemo } from "react";
import { useMotion } from "./opentui-motion.js";

/** Shared native scrollbar defaults for the single OpenTUI appearance. */
export function TerminalScrollbox(props: ScrollBoxProps) {
  const { enabled } = useMotion();
  const acceleration = useMemo(
    () =>
      enabled
        ? new MacOSScrollAccel({ maxMultiplier: 5 })
        : new LinearScrollAccel(),
    [enabled],
  );
  return (
    <scrollbox
      scrollAcceleration={acceleration}
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
