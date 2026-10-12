import type { KeyEvent, KeyHandler, PasteEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";

type KeyboardHub = {
  handlers: Set<(event: KeyEvent) => void>;
  dispatch(event: KeyEvent): void;
};
const keyboards = new WeakMap<KeyHandler, KeyboardHub>();

/** One UI subscription per renderer, preserving OpenTUI's ordered propagation. */
export function useUiKeyboard(handler: (event: KeyEvent) => void): void {
  const renderer = useRenderer();
  const stable = useEffectEvent(handler);
  useEffect(() => {
    const input = renderer.keyInput;
    let hub = keyboards.get(input);
    if (!hub) {
      const handlers = new Set<(event: KeyEvent) => void>();
      hub = {
        handlers,
        dispatch(event) {
          // A dialog mounted by this key cannot receive the same event.
          for (const callback of [...handlers]) {
            try {
              callback(event);
            } catch (error) {
              console.error(
                "[KeyHandler] Error in global keypress handler:",
                error,
              );
            }
            if (event.propagationStopped) break;
          }
        },
      };
      keyboards.set(input, hub);
      input.on("keypress", hub.dispatch);
    }
    hub.handlers.add(stable);
    return () => {
      hub.handlers.delete(stable);
      if (!hub.handlers.size) {
        input.off("keypress", hub.dispatch);
        keyboards.delete(input);
      }
    };
  }, [renderer]);
}

const owners = new WeakMap<object, string>();
const liveInputs = new WeakMap<
  KeyHandler,
  { owner: string; revision: number }
>();
/** Shared mouse gate; descriptors never register their own input/resize listeners. */
export function uiInputStamp(input: KeyHandler): string {
  const state = liveInputs.get(input);
  return state ? `${state.owner}/${state.revision}` : "unbound";
}
export function capturedInputOwner(event: object): string | undefined {
  return owners.get(event);
}

/** Capture before global listeners: a key cannot move to a newly mounted overlay. */
export function useOverlayInputOwner(owner: string): void {
  const renderer = useRenderer();
  const current = useRef(owner);
  current.current = owner;
  const live = liveInputs.get(renderer.keyInput);
  if (live) {
    if (live.owner !== owner) {
      live.owner = owner;
      ++live.revision;
    }
  } else liveInputs.set(renderer.keyInput, { owner, revision: 0 });
  useLayoutEffect(() => {
    const resized = () => {
      const state = liveInputs.get(renderer.keyInput);
      if (state) ++state.revision;
    };
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
    renderer.on("resize", resized);
    return () => {
      renderer.keyInput.off("keypress", capture);
      renderer.keyInput.off("paste", capture);
      renderer.off("resize", resized);
      liveInputs.delete(renderer.keyInput);
    };
  }, [renderer]);
}
