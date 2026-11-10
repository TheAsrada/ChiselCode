import type {
  CliRenderer,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import { DEFAULT_APPROVAL_MODE } from "../security/approval-mode.js";
import type { SecretRedactor } from "../security/redaction.js";
import { ExtensionUiBinding, type UiToolSubmit } from "./extension-ui.js";
import type {
  TuiPresentationController as TuiController,
  TuiViewState,
} from "./tui-controller.js";
import type { WorkspaceCommandsPort } from "./workspace-commands.js";

export function useConversationBindings({
  transcript,
  editor,
  nativeRenderer,
  controller,
  commandActions,
  onUiTool,
  uiRedactor,
}: {
  transcript: React.RefObject<ScrollBoxRenderable | null>;
  editor: React.RefObject<TextareaRenderable | null>;
  nativeRenderer: CliRenderer;
  controller: TuiController | undefined;
  commandActions: WorkspaceCommandsPort | undefined;
  onUiTool: UiToolSubmit | undefined;
  uiRedactor: SecretRedactor | undefined;
}) {
  const [view, setView] = useState<TuiViewState>(
    () =>
      controller?.snapshot ?? {
        projectPath: process.cwd(),
        agentMode: DEFAULT_AGENT_MODE,
        approvalMode: DEFAULT_APPROVAL_MODE,
        transcript: [],
        streaming: "",
        draft: "",
        focus: "composer",
      },
  );

  const compositionPosition = useRef<
    | {
        owner: string;
        generation: number;
        editor: TextareaRenderable | null;
        cursor: number;
        scroll: ScrollBoxRenderable | null;
        top: number;
        pinned: boolean;
      }
    | undefined
  >(undefined);

  const priorContributions = useRef(view.uiContributions);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Стабильные native refs читаются при уведомлении; движение курсора и прокрутка не пересоздают подписку.
  useEffect(
    () =>
      controller?.subscribe((next) => {
        if (next.uiContributions !== priorContributions.current) {
          priorContributions.current = next.uiContributions;
          const scroll = transcript.current;
          compositionPosition.current ??= {
            owner: controller.conversationId,
            generation: controller.currentGeneration,
            editor: editor.current,
            cursor: editor.current?.cursorOffset ?? 0,
            scroll,
            top: scroll?.scrollTop ?? 0,
            pinned:
              !scroll ||
              scroll.scrollTop >=
                scroll.scrollHeight - scroll.viewport.height - 1,
          };
        }
        setView(next);
      }),
    [controller],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore native position after a composition commit, including structural changes that replace refs.
  useLayoutEffect(() => {
    const saved = compositionPosition.current;
    compositionPosition.current = undefined;
    if (
      !saved ||
      saved.owner !== controller?.conversationId ||
      saved.generation !== controller.currentGeneration
    )
      return;
    if (editor.current && saved.editor !== editor.current)
      editor.current.cursorOffset = Math.min(
        saved.cursor,
        editor.current.plainText.length,
      );
    if (
      transcript.current &&
      saved.scroll !== transcript.current &&
      !saved.pinned
    ) {
      const scroll = transcript.current;
      const restore = () => {
        if (transcript.current === scroll) scroll.scrollTo(saved.top);
      };
      nativeRenderer.once("frame", restore);
      nativeRenderer.requestRender();
      return () => {
        nativeRenderer.off("frame", restore);
      };
    }
  }, [controller, nativeRenderer, view.uiContributions]);

  const uiBinding = controller?.uiBinding;

  const bindingGeneration = controller?.currentGeneration;

  const [uiEpoch, setUiEpoch] = useState(0);

  useEffect(
    () => commandActions?.subscribeUi?.(() => setUiEpoch((epoch) => epoch + 1)),
    [commandActions],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Session allocation replaces the pre-session binding without creating a session from a view.
  useEffect(() => {
    if (!controller || !commandActions?.uiScope) return;
    let active = true;
    let binding: ExtensionUiBinding | undefined;
    const root = controller.snapshot.projectPath;
    if (!root) return;
    void (
      commandActions.uiScopes
        ? commandActions.uiScopes(root, controller.ownerSignal)
        : commandActions
            .uiScope(root, controller.ownerSignal)
            .then((scope) => (scope ? [scope] : []))
    ).then(([scope, ...additional]) => {
      if (
        !active ||
        !scope ||
        controller.ownerSignal.aborted ||
        controller.currentGeneration !== bindingGeneration
      )
        return;
      binding = new ExtensionUiBinding(
        controller,
        scope,
        onUiTool,
        uiRedactor,
        additional,
      );
      controller.uiBinding = binding;
    });
    return () => {
      active = false;
      binding?.dispose();
      if (controller.uiBinding === binding) controller.uiBinding = undefined;
    };
  }, [
    controller,
    commandActions,
    onUiTool,
    uiRedactor,
    bindingGeneration,
    view.sessionId,
    uiEpoch,
  ]);
  return { view, setView, uiBinding };
}
