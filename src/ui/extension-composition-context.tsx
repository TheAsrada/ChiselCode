/** @jsxImportSource @opentui/react */
import {
  createContext,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  UiInputEvent,
  UiPresentationContext,
} from "../extension-sdk/ui-composition.js";
import type {
  OwnedUiContribution,
  UiActionUse,
} from "../extensions/ui-types.js";
import { type Palette, THEMES } from "./appearance.js";

export type Composition = {
  binding?: string;
  items: readonly OwnedUiContribution[];
  palette: Palette;
  dispatch?(
    key: string,
    use: UiActionUse,
    revision: number,
    presentation?: UiPresentationContext,
  ): void;
  interactive?: boolean;
  focus?: { key: string; nodeKey: string; instance?: string };
  setFocus?(focus?: { key: string; nodeKey: string; instance?: string }): void;
  owner?: string;
  event?(
    key: string,
    nodeKey: string,
    event: UiInputEvent,
    revision: number,
    presentation?: UiPresentationContext,
  ): void;
  targets?: readonly ControlTarget[];
  registerTarget?(target: ControlTarget): () => void;
  drafts?: Map<string, { value: string; source: string; cursor: number }>;
  collapsed?: ReadonlySet<string>;
  paneState?: Set<string>;
  togglePane?(key: string): void;
};
export type ControlTarget = {
  id: string;
  key: string;
  nodeKey: string;
  instance: string;
  label: string;
  action?: UiActionUse;
};
export const UiCompositionContext = createContext<Composition>({
  items: [],
  palette: THEMES.obsidian,
});
export function UiCompositionProvider({
  value,
  children,
}: {
  value: Composition;
  children: ReactNode;
}) {
  const [targets, setTargets] = useState<readonly ControlTarget[]>([]);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const drafts = useRef(
    new Map<string, { value: string; source: string; cursor: number }>(),
  );
  const fallbackPanes = useRef(new Set<string>());
  const collapsed = value.paneState ?? fallbackPanes.current;
  const [, refreshPanes] = useState(0);
  const registerTarget = useCallback((target: ControlTarget) => {
    if (alive.current)
      setTargets((current) => [
        ...current.filter((t) => t.id !== target.id),
        target,
      ]);
    return () => {
      if (alive.current)
        setTargets((current) => current.filter((t) => t.id !== target.id));
    };
  }, []);
  const togglePane = useCallback(
    (key: string) => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      refreshPanes((revision) => revision + 1);
    },
    [collapsed],
  );
  return (
    <UiCompositionContext
      value={{
        ...value,
        targets,
        registerTarget,
        drafts: value.drafts ?? drafts.current,
        collapsed,
        togglePane,
      }}
    >
      {children}
    </UiCompositionContext>
  );
}
export type Values = Partial<
  Record<"text" | "title" | "state" | "count" | "path", string | number>
>;
