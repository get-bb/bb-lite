import type { FollowUpSubmitMode } from "@bb/client-core";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { PromptTextMention, ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { ComposerContext } from "@bb/plugin/app";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import { modifierSubmitShortcutLabel } from "./modifier-submit-shortcut";
import { isKeyboardFocusTarget } from "@bb/app-kit/components/layout/useMobileVisualViewportHeight";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "./PromptBoxInternal";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "../pickers/ModelReasoningPicker";
import {
  ComposerFooterControls,
  type ComposerFooterHost,
  type ComposerScope,
} from "./composer-slots";
import { useBottomAnchoredScroll } from "@bb/app-kit/components/ui/bottom-anchored-scroll-body";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { ThreadTimelineScrollToBottomButton } from "@bb/app-kit/views/thread-detail/ThreadTimelineScrollToBottomButton";
import { useOptionalPaneContext } from "@bb/app-kit/views/thread-detail/PaneContext";
import type { ThreadContextWindowIndicator } from "bb-plugin-thread-view/contract";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_TRACK_CLASS,
} from "./banner/PromptStackCard";

const MIN_HEIGHT = 68;
const COMPOSER_CONTROL_SELECTOR = "button, [role='button'], [aria-haspopup]";
const OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR =
  '[aria-haspopup][aria-expanded="true"]';
const MOBILE_KEYBOARD_VIEWPORT_MIN_DELTA_PX = 80;
const MOBILE_FOCUS_EXPANSION_FALLBACK_MS = 350;
const MOBILE_KEYBOARD_DISMISSAL_FALLBACK_MS = 750;
const BLOCKED_REASON_TITLE = {
  "loading-execution-options": "Loading models...",
  "loading-pending-interactions": "Checking pending interactions...",
  "pending-interaction": undefined,
  unavailable: "Unavailable",
};

export type { FollowUpSubmitMode } from "@bb/client-core";

export interface FollowUpComposerProps {
  history?: HistoryConfig;
  isFollowUpSubmitting: boolean;
  message: string;
  mentionRanges: readonly PromptTextMention[];
  onChangeMessage: (value: string, mentionRanges: PromptTextMention[]) => void;
  onModifierSubmit: () => void;
  onSubmit: () => void;
  onEscape?: () => void;
  compactPromptPlaceholder: string;
  promptPlaceholder: string;
  canModifierSubmit: boolean;
  steerActiveThreadOnEnter: boolean;
  submitMode: FollowUpSubmitMode;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

export interface FollowUpPromptBoxProps {
  id?: string;
  threadId?: string | null;
  attachments: AttachmentsConfig;
  stack: ReactNode | null;
  composer: FollowUpComposerProps | null;
  environmentSummary: ReactNode | null;
  contextWindowUsage:
    | ComponentProps<typeof ThreadContextWindowIndicator>["usage"]
    | null;
  execution: ExecutionControlsProps;
  permission: ExecutionPermissionConfig;
  executionReadOnly?: boolean;
  permissionReadOnly?: boolean;
  typeahead: TypeaheadConfig;
  promptActions?: readonly PromptBoxAction[];
  preferExpanded?: boolean;
  focusEndKey?: string | number;
  isPrimaryComposer?: boolean;
  showScrollToBottomButton?: boolean;
  pendingInteraction?: ReactNode;
}

function waitForKeyboardViewport(
  visualViewport: VisualViewport,
  direction: 1 | -1,
  fallbackMs: number,
  onSettled: () => void,
): () => void {
  const initialHeight = visualViewport.height;
  let hasFinished = false;
  const cleanup = () => {
    visualViewport.removeEventListener("resize", handleResize);
    window.clearTimeout(fallbackTimeout);
  };
  const finish = () => {
    if (hasFinished) return;
    hasFinished = true;
    cleanup();
    onSettled();
  };
  const handleResize = () => {
    if (
      (visualViewport.height - initialHeight) * direction >=
      MOBILE_KEYBOARD_VIEWPORT_MIN_DELTA_PX
    ) {
      finish();
    }
  };
  visualViewport.addEventListener("resize", handleResize);
  const fallbackTimeout = window.setTimeout(finish, fallbackMs);
  return cleanup;
}

function FollowUpPromptBoxWithComposer({
  id,
  threadId = null,
  attachments,
  stack,
  composer,
  environmentSummary,
  contextWindowUsage,
  execution,
  permission,
  executionReadOnly = false,
  permissionReadOnly = false,
  typeahead,
  promptActions,
  preferExpanded = false,
  focusEndKey,
  isPrimaryComposer = true,
  showScrollToBottomButton = true,
  pendingInteraction = null,
}: FollowUpPromptBoxProps & { composer: FollowUpComposerProps }) {
  const { submitMode } = composer;
  const hasPendingInteraction =
    pendingInteraction !== null && pendingInteraction !== undefined;
  const isStopping = submitMode.kind === "queue-while-stopping";
  const canQueue = submitMode.kind === "queue" || isStopping;
  const canSubmit = submitMode.kind === "ready" || canQueue;
  const blockedTitle =
    submitMode.kind === "blocked"
      ? BLOCKED_REASON_TITLE[submitMode.reason]
      : undefined;
  const onStop = submitMode.kind === "queue" ? submitMode.onStop : undefined;
  const steerOnEnter =
    submitMode.kind === "queue" && composer.steerActiveThreadOnEnter;
  const onModifierSubmit = composer.canModifierSubmit
    ? composer.onModifierSubmit
    : undefined;
  const modifierHint = (action: "queue" | "steer") =>
    onModifierSubmit ? `, ${modifierSubmitShortcutLabel()} to ${action}` : "";
  const status = composer.threadRuntimeDisplayStatus;

  const bottomAnchor = useBottomAnchoredScroll();
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const pressedControlRef = useRef(false);
  const pressedControlCleanupRef = useRef<(() => void) | null>(null);
  const pendingFocusExpansionCleanupRef = useRef<(() => void) | null>(null);
  const pendingFocusLossCleanupRef = useRef<(() => void) | null>(null);
  const deferredControlFocusLossRef = useRef<(() => void) | null>(null);
  const expandedRef = useRef(false);
  const [isInteractionExpanded, setIsInteractionExpanded] = useState(false);
  const [stackHeight, setStackHeight] = useState(0);
  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const isEditorExpanded = isInteractionExpanded || preferExpanded;
  const isPromptBoxCompact = isCompactViewport && !isEditorExpanded;

  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", () => {
    if (!isFocusedPane || !isPrimaryComposer || !promptBoxRef.current) {
      return false;
    }
    promptBoxRef.current.focusEnd();
    return true;
  });

  useLayoutEffect(() => {
    const element = stackRef.current;
    if (!element) return;
    const measure = () => setStackHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const setExpanded = (expanded: boolean) => {
    if (expanded === expandedRef.current) return;
    expandedRef.current = expanded;
    promptBoxRef.current?.captureHeightForLayoutChange();
    setIsInteractionExpanded(expanded);
  };
  const cancelPendingFocusExpansion = () => {
    pendingFocusExpansionCleanupRef.current?.();
    pendingFocusExpansionCleanupRef.current = null;
  };
  const cancelPendingFocusLoss = () => {
    deferredControlFocusLossRef.current = null;
    const cleanup = pendingFocusLossCleanupRef.current;
    pendingFocusLossCleanupRef.current = null;
    cleanup?.();
  };
  const cancelPressedControl = () => {
    const cleanup = pressedControlCleanupRef.current;
    pressedControlCleanupRef.current = null;
    cleanup?.();
  };
  useEffect(
    () => () => {
      pendingFocusExpansionCleanupRef.current?.();
      pendingFocusLossCleanupRef.current?.();
      pressedControlCleanupRef.current?.();
    },
    [],
  );

  const handlePointerDown = (event: ReactPointerEvent) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(COMPOSER_CONTROL_SELECTOR)
    ) {
      return;
    }
    cancelPendingFocusExpansion();
    cancelPendingFocusLoss();
    cancelPressedControl();
    pressedControlRef.current = true;
    let releaseTimeout: number | null = null;
    const removeReleaseListeners = () => {
      window.removeEventListener("pointerup", finishRelease, true);
      window.removeEventListener("pointercancel", finishRelease, true);
    };
    const finishRelease = () => {
      removeReleaseListeners();
      releaseTimeout = window.setTimeout(() => {
        releaseTimeout = null;
        pressedControlRef.current = false;
        pressedControlCleanupRef.current = null;
        const resumeFocusLoss = deferredControlFocusLossRef.current;
        deferredControlFocusLossRef.current = null;
        resumeFocusLoss?.();
      });
    };
    window.addEventListener("pointerup", finishRelease, true);
    window.addEventListener("pointercancel", finishRelease, true);
    pressedControlCleanupRef.current = () => {
      removeReleaseListeners();
      if (releaseTimeout !== null) window.clearTimeout(releaseTimeout);
      pressedControlRef.current = false;
    };
  };
  const handleFocus = (event: ReactFocusEvent) => {
    cancelPendingFocusLoss();
    if (pressedControlRef.current || expandedRef.current) return;
    const { visualViewport } = window;
    if (
      !isCompactViewport ||
      !isPointerCoarse ||
      !isKeyboardFocusTarget(event.target) ||
      !visualViewport
    ) {
      setExpanded(true);
      return;
    }
    if (pendingFocusExpansionCleanupRef.current) return;
    let animationFrame: number | null = null;
    const stopWaiting = waitForKeyboardViewport(
      visualViewport,
      -1,
      MOBILE_FOCUS_EXPANSION_FALLBACK_MS,
      () => {
        animationFrame = window.requestAnimationFrame(() => {
          animationFrame = null;
          pendingFocusExpansionCleanupRef.current = null;
          setExpanded(true);
        });
      },
    );
    pendingFocusExpansionCleanupRef.current = () => {
      stopWaiting();
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  };
  const scheduleCollapseAfterFocusLoss = (event: ReactFocusEvent) => {
    cancelPendingFocusLoss();
    const dismissedKeyboard = isKeyboardFocusTarget(event.target);
    const scheduleFocusLoss = () => {
      const frame = window.requestAnimationFrame(checkFocusLoss);
      pendingFocusLossCleanupRef.current = () => {
        window.cancelAnimationFrame(frame);
      };
    };
    const checkFocusLoss = () => {
      pendingFocusLossCleanupRef.current = null;
      const element = composerRef.current;
      if (!element || element.contains(document.activeElement)) return;
      if (pressedControlRef.current) {
        deferredControlFocusLossRef.current = scheduleFocusLoss;
        return;
      }
      if (element.querySelector(OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR)) {
        return;
      }
      const collapse = () => {
        cancelPendingFocusExpansion();
        setExpanded(false);
      };
      const focusSettledOnDocument =
        document.activeElement === document.body ||
        document.activeElement === document.documentElement;
      const { visualViewport } = window;
      if (
        !dismissedKeyboard ||
        !focusSettledOnDocument ||
        !isCompactViewport ||
        !isPointerCoarse ||
        !visualViewport
      ) {
        collapse();
        return;
      }
      pendingFocusLossCleanupRef.current = waitForKeyboardViewport(
        visualViewport,
        1,
        MOBILE_KEYBOARD_DISMISSAL_FALLBACK_MS,
        () => {
          pendingFocusLossCleanupRef.current = null;
          collapse();
        },
      );
    };
    scheduleFocusLoss();
  };

  const composerScope: ComposerScope = {
    surface: "follow-up",
    threadId,
    projectId: attachments.projectId ?? null,
  };
  const footerHost: ComposerFooterHost = {
    model: {
      ...execution,
      muted: true,
      disabled: executionReadOnly || hasPendingInteraction,
    },
    permission: {
      value: permission.value,
      options: permission.options,
      onChange: permission.onChange,
      supported: permission.supported,
      disabled: permissionReadOnly || hasPendingInteraction,
      className: "h-6",
    },
    project: null,
    environment: environmentSummary,
    contextWindowUsage,
  };
  const footerContext: ComposerContext = { ...composerScope, host: footerHost };

  return (
    <>
      {showScrollToBottomButton ? (
        <ThreadTimelineScrollToBottomButton active={status === "active"} />
      ) : null}
      <div
        data-app-composer=""
        data-app-composer-role={isPrimaryComposer ? "primary" : "secondary"}
        data-promptbox-shell=""
        className="space-y-2"
      >
        <div
          ref={stackRef}
          className={`grid gap-2 ${PROMPT_STACK_TRACK_CLASS}`}
        >
          {stack}
          {pendingInteraction}
        </div>
        <div data-follow-up-composer-anchor="">
          <div
            ref={composerRef}
            className="relative z-20"
            data-follow-up-composer=""
            data-follow-up-composer-expanded={isEditorExpanded ? "" : undefined}
            hidden={hasPendingInteraction}
            onBlurCapture={scheduleCollapseAfterFocusLoss}
            onFocusCapture={handleFocus}
            onPointerDownCapture={handlePointerDown}
          >
            <PromptBoxInternal
              id={id}
              promptBoxRef={promptBoxRef}
              minHeight={
                stack === null
                  ? MIN_HEIGHT
                  : Math.max(
                      MIN_HEIGHT,
                      MIN_HEIGHT + PROMPT_STACK_CARD_ROW_HEIGHT - stackHeight,
                    )
              }
              value={composer.message}
              mentionRanges={composer.mentionRanges}
              onChange={composer.onChangeMessage}
              onSubmit={() => {
                composer.onSubmit();
                if (submitMode.kind !== "queue") bottomAnchor?.scrollToBottom();
              }}
              onEscape={composer.onEscape}
              blurOnPointerSubmit={isCompactViewport && isPointerCoarse}
              history={composer.history}
              focusEndKey={focusEndKey}
              placeholder={composer.promptPlaceholder}
              containerCompactPlaceholder={composer.compactPromptPlaceholder}
              heightAnimationKey={isEditorExpanded ? "expanded" : "compact"}
              mentionMenuPlacement="top"
              submission={{
                onStop,
                isSubmitting: composer.isFollowUpSubmitting,
                disabled:
                  !canSubmit ||
                  composer.isFollowUpSubmitting ||
                  (steerOnEnter && !composer.canModifierSubmit),
                disabledReason: composer.isFollowUpSubmitting
                  ? "Submitting..."
                  : blockedTitle,
                onModifierSubmit: onModifierSubmit
                  ? () => {
                      onModifierSubmit();
                      bottomAnchor?.scrollToBottom();
                    }
                  : undefined,
                swapSubmitActions: steerOnEnter,
                showModifierSubmitAction: submitMode.kind === "queue",
                title: composer.isFollowUpSubmitting
                  ? "Submitting..."
                  : isStopping
                    ? "Queue for after the stop (Enter)"
                    : !canQueue
                      ? (blockedTitle ?? "Submit (Enter)")
                      : !steerOnEnter
                        ? `Queue follow-up (Enter)${modifierHint("steer")}`
                        : status === "provisioning" || status === "starting"
                          ? `Steer when ready (Enter)${modifierHint("queue")}`
                          : `Steer current run (Enter)${modifierHint("queue")}`,
                isRunning: onStop !== undefined,
              }}
              typeahead={typeahead}
              attachments={attachments}
              promptActions={promptActions}
              compact={
                isCompactViewport
                  ? {
                      isCompact: isPromptBoxCompact,
                      placeholder: composer.compactPromptPlaceholder,
                    }
                  : undefined
              }
              composerScope={composerScope}
              pickers={footerHost}
              footerStart={
                <ComposerFooterControls
                  row="actions"
                  side="start"
                  context={footerContext}
                />
              }
            />
            {isPromptBoxCompact ? null : (
              <div
                data-follow-up-composer-footer=""
                className="mt-1 flex min-h-6 max-h-6 select-none items-center justify-between gap-2 overflow-hidden pl-[15px] pr-3.5 opacity-100 transition-[max-height,min-height,margin-top,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                  <ComposerFooterControls
                    row="status"
                    side="start"
                    context={footerContext}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ComposerFooterControls
                    row="status"
                    side="end"
                    context={footerContext}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export const FollowUpPromptBox = memo(function FollowUpPromptBox(
  props: FollowUpPromptBoxProps,
) {
  if (props.composer !== null) {
    return (
      <FollowUpPromptBoxWithComposer {...props} composer={props.composer} />
    );
  }
  return props.stack ? (
    <div data-promptbox-shell="" className="space-y-2">
      <div className={`grid gap-2 ${PROMPT_STACK_TRACK_CLASS}`}>
        {props.stack}
      </div>
    </div>
  ) : null;
});
