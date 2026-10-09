import type { KeyEvent, PasteEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useLayoutEffect, useRef } from "react";

const owners = new WeakMap<object, string>();
export function capturedInputOwner(event: object): string | undefined {
  return owners.get(event);
}

/** Capture before global listeners: a key cannot move to a newly mounted overlay. */
export function useOverlayInputOwner(owner: string): void {
  const renderer = useRenderer();
  const current = useRef(owner);
  current.current = owner;
  useLayoutEffect(() => {
    const capture = (event: KeyEvent | PasteEvent) => {
      owners.set(event, current.current);
      if (
        current.current === "approval" &&
        ("bytes" in event || ("repeated" in event && event.repeated))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    renderer.keyInput.prependListener("keypress", capture);
    renderer.keyInput.prependListener("paste", capture);
    return () => {
      renderer.keyInput.off("keypress", capture);
      renderer.keyInput.off("paste", capture);
    };
  }, [renderer]);
}
