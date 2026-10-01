import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import type { FollowUpSubmitMode } from "@bb/client-core";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  PromptTextMention,
  ThreadRuntimeDisplayStatus,
  ThreadTimelineActivePromptMode,
} from "@bb/domain";
import { modifierSubmitShortcutLabel } from "./modifier-submit-shortcut";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { useComposerExtensionController } from "@/components/plugin/ComposerExtensionHost";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptModePermissionDisplay } from "@/components/promptbox/usePromptModePermissionDisplay";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { ThreadTimelineScrollToBottomButton } from "@/views/thread-detail/ThreadTimelineScrollToBottomButton";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { ThreadContextWindowIndicator } from "@/components/thread/timeline";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_TRACK_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";

type PromptBoxWithScrollAnchorProps = ComponentProps<
  typeof PromptBoxInternal
> & {
  scrollToBottomOnSubmit?: boolean;
};

function PromptBoxWithScrollAnchor({
  onSubmit,
  scrollToBottomOnSubmit = true,
  submission,
  ...promptBoxProps
}: PromptBoxWithScrollAnchorProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const handleSubmit = () => {
    onSubmit();
    if (scrollToBottomOnSubmit) {
      bottomAnchor?.scrollToBottom();
    }
  };
  const handleModifierSubmit =
    submission?.onModifierSubmit === undefined
      ? undefined
      : () => {
          submission.onModifierSubmit?.();
          bottomAnchor?.scrollToBottom();
        };
  const anchoredSubmission =
    submission === undefined
      ? undefined
      : {
          ...submission,
          ...(handleModifierSubmit
            ? { onModifierSubmit: handleModifierSubmit }
            : {}),
        };
  return (
    <PromptBoxInternal
      {...promptBoxProps}
      onSubmit={handleSubmit}
      submission={anchoredSubmission}
    />
  );
}

const FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT = 68;
const FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT =
  FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT + PROMPT_STACK_CARD_ROW_HEIGHT;
const COMPOSER_CONTROL_SELECTOR = "button, [role='button'], [aria-haspopup]";
const COMPOSER_OVERLAY_TRIGGER_SELECTOR = "[aria-haspopup]";
const OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR = `${COMPOSER_OVERLAY_TRIGGER_SELECTOR}[aria-expanded="true"]`;

export type { FollowUpSubmitMode } from "@bb/client-core";

export interface FollowUpComposerProps {
  history: HistoryConfig;
  isFollowUpSubmitting: boolean;
  message: string;
  mentionRanges: readonly PromptTextMention[];
  onChangeMessage: (value: string, mentionRanges: PromptTextMention[]) => void;
  onModifierSubmit: () => void;
  onSubmit: () => void;
  onEscape?: () => void;
  submitLabel?: string;
  submitIcon?: IconName;
  submitTitle?: string;
  compactPromptPlaceholder: string;
  promptPlaceholder: string;
  canModifierSubmit: boolean;
  steerActiveThreadOnEnter: boolean;
  submitMode: FollowUpSubmitMode;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
}

type ContextWindowUsage = ComponentProps<
  typeof ThreadContextWindowIndicator
>["usage"];

export interface FollowUpPromptBoxProps {
  id?: string;
  attachments: AttachmentsConfig;
  stack: ReactNode | null;
  activePromptMode?: ThreadTimelineActivePromptMode | null;
  composer: FollowUpComposerProps | null;
  environmentSummary: ReactNode | null;
  contextWindowUsage: ContextWindowUsage | null;
  execution: ExecutionControlsProps;
  permission: ExecutionPermissionConfig;
  executionReadOnly?: boolean;
  permissionReadOnly?: boolean;
  typeahead: TypeaheadConfig;
  promptActions?: readonly PromptBoxAction[];
  pluginComposerHost?: PluginComposerHost | null;
  collapseResetKey: string | number;
  preferExpanded?: boolean;
  focusEndKey?: string | number;
  isPrimaryComposer?: boolean;
  showScrollToBottomButton?: boolean;
  pendingInteraction?: ReactNode;
}

type FollowUpPromptBoxWithComposerProps = Omit<
  FollowUpPromptBoxProps,
  "composer"
> & {
  composer: FollowUpComposerProps;
};

function FollowUpPromptBoxStackOnly({
  stack,
}: Pick<FollowUpPromptBoxProps, "stack">) {
  if (!stack) {
    return null;
  }
  return (
    <div data-promptbox-shell="" className="space-y-2">
      <div className={`grid gap-2 ${PROMPT_STACK_TRACK_CLASS}`}>{stack}</div>
    </div>
  );
}

function FollowUpPromptBoxWithComposer({
  id,
  attachments,
  stack,
  activePromptMode = null,
  composer,
  environmentSummary,
  contextWindowUsage,
  execution,
  permission,
  executionReadOnly,
  permissionReadOnly,
  typeahead,
  promptActions,
  pluginComposerHost,
  collapseResetKey,
  preferExpanded = false,
  focusEndKey,
  isPrimaryComposer = true,
  showScrollToBottomButton = true,
  pendingInteraction = null,
}: FollowUpPromptBoxWithComposerProps) {
  const submitMode = composer.submitMode;
  const hasPendingInteraction =
    pendingInteraction !== null && pendingInteraction !== undefined;
  const isStopping = submitMode.kind === "queue-while-stopping";
  const canQueueFollowUp = submitMode.kind === "queue" || isStopping;
  const canSubmit = submitMode.kind === "ready" || canQueueFollowUp;
  const isLoadingExecutionOptions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-execution-options";
  const isLoadingPendingInteractions =
    submitMode.kind === "blocked" &&
    submitMode.reason === "loading-pending-interactions";
  const isUnavailable =
    submitMode.kind === "blocked" && submitMode.reason === "unavailable";
  const onStopRuntime =
    submitMode.kind === "queue" ? submitMode.onStop : undefined;
  const canStopRuntime = onStopRuntime !== undefined;
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const focusDefault = useCallback(() => {
    promptBoxRef.current?.focusEnd();
    return promptBoxRef.current !== null;
  }, []);
  const composerInteractionRef = useRef<HTMLDivElement>(null);
  const interactionExpandedRef = useRef(false);
  const pendingFocusLossCleanupRef = useRef<(() => void) | null>(null);
  const deferredControlFocusLossRef = useRef<(() => void) | null>(null);
  const pressedComposerControlRef = useRef(false);
  const pressedComposerControlCleanupRef = useRef<(() => void) | null>(null);
  const [isInteractionExpanded, setIsInteractionExpanded] = useState(false);
  const [widePromptBoxCollapsedFor, setWidePromptBoxCollapsedFor] = useState<
    string | number | null
  >(null);
  const isWidePromptBoxCollapsed =
    widePromptBoxCollapsedFor === collapseResetKey;
  const isEditorExpanded =
    isInteractionExpanded || (preferExpanded && !isWidePromptBoxCollapsed);
  const compactConfig = useMemo(
    () =>
      isWidePromptBoxCollapsed
        ? {
            isCompact: true,
            placeholder: composer.compactPromptPlaceholder,
          }
        : undefined,
    [composer.compactPromptPlaceholder, isWidePromptBoxCollapsed],
  );
  const setInteractionExpanded = useCallback((nextExpanded: boolean) => {
    if (interactionExpandedRef.current === nextExpanded) return;
    interactionExpandedRef.current = nextExpanded;
    promptBoxRef.current?.captureHeightForLayoutChange();
    setIsInteractionExpanded(nextExpanded);
  }, []);
  const cancelPendingFocusLoss = useCallback(() => {
    deferredControlFocusLossRef.current = null;
    const cleanup = pendingFocusLossCleanupRef.current;
    pendingFocusLossCleanupRef.current = null;
    cleanup?.();
  }, []);
  const cancelPressedComposerControl = useCallback(() => {
    const cleanup = pressedComposerControlCleanupRef.current;
    pressedComposerControlCleanupRef.current = null;
    cleanup?.();
  }, []);
  const handleComposerPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(COMPOSER_CONTROL_SELECTOR)
      ) {
        return;
      }

      cancelPendingFocusLoss();
      cancelPressedComposerControl();
      pressedComposerControlRef.current = true;
      let releaseTimeout: number | null = null;
      const removeReleaseListeners = () => {
        window.removeEventListener("pointerup", finishRelease, true);
        window.removeEventListener("pointercancel", finishRelease, true);
      };
      const finishRelease = () => {
        removeReleaseListeners();
        releaseTimeout = window.setTimeout(() => {
          releaseTimeout = null;
          pressedComposerControlRef.current = false;
          pressedComposerControlCleanupRef.current = null;
          const resumeFocusLoss = deferredControlFocusLossRef.current;
          deferredControlFocusLossRef.current = null;
          resumeFocusLoss?.();
        });
      };
      const cleanup = () => {
        removeReleaseListeners();
        if (releaseTimeout !== null) {
          window.clearTimeout(releaseTimeout);
        }
        pressedComposerControlRef.current = false;
      };

      window.addEventListener("pointerup", finishRelease, {
        capture: true,
        once: true,
      });
      window.addEventListener("pointercancel", finishRelease, {
        capture: true,
        once: true,
      });
      pressedComposerControlCleanupRef.current = cleanup;
    },
    [cancelPendingFocusLoss, cancelPressedComposerControl],
  );
  const handleComposerFocus = useCallback(() => {
    cancelPendingFocusLoss();
    if (pressedComposerControlRef.current) return;
    setWidePromptBoxCollapsedFor(null);
    if (interactionExpandedRef.current) return;
    setInteractionExpanded(true);
  }, [cancelPendingFocusLoss, setInteractionExpanded]);
  const scheduleCollapseAfterFocusLoss = useCallback(() => {
    cancelPendingFocusLoss();
    const scheduleFocusLoss = () => {
      const frame = window.requestAnimationFrame(checkFocusLoss);
      pendingFocusLossCleanupRef.current = () => {
        window.cancelAnimationFrame(frame);
      };
    };
    const checkFocusLoss = () => {
      pendingFocusLossCleanupRef.current = null;
      const composerElement = composerInteractionRef.current;
      if (!composerElement) return;

      if (composerElement.contains(document.activeElement)) return;

      if (pressedComposerControlRef.current) {
        deferredControlFocusLossRef.current = scheduleFocusLoss;
        return;
      }

      if (
        composerElement.querySelector(OPEN_COMPOSER_OVERLAY_TRIGGER_SELECTOR)
      ) {
        return;
      }

      setInteractionExpanded(false);
    };
    scheduleFocusLoss();
  }, [cancelPendingFocusLoss, setInteractionExpanded]);
  const collapseWidePromptBox = useCallback(() => {
    cancelPendingFocusLoss();
    interactionExpandedRef.current = false;
    setIsInteractionExpanded(false);
    setWidePromptBoxCollapsedFor(collapseResetKey);
  }, [cancelPendingFocusLoss, collapseResetKey]);
  const collapseIfFocused = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      !(activeElement instanceof HTMLElement) ||
      !composerInteractionRef.current?.contains(activeElement)
    ) {
      return false;
    }
    promptBoxRef.current?.captureHeightForLayoutChange();
    activeElement.blur();
    collapseWidePromptBox();
    return true;
  }, [collapseWidePromptBox]);
  useComposerExtensionController({
    host: pluginComposerHost ?? null,
    isFocused: isFocusedPane,
    isPrimary: isPrimaryComposer,
    collapseIfFocused,
    focusDefault,
  });
  useEffect(
    () => () => {
      cancelPendingFocusLoss();
      cancelPressedComposerControl();
    },
    [cancelPendingFocusLoss, cancelPressedComposerControl],
  );
  const steerOnPrimarySubmit =
    submitMode.kind === "queue" && composer.steerActiveThreadOnEnter;
  const isSteeringWhenReady =
    steerOnPrimarySubmit &&
    (composer.threadRuntimeDisplayStatus === "provisioning" ||
      composer.threadRuntimeDisplayStatus === "starting");
  const onModifierSubmit = composer.canModifierSubmit
    ? composer.onModifierSubmit
    : undefined;
  const modifierSubmitHint = (action: "queue" | "steer"): string =>
    onModifierSubmit ? `, ${modifierSubmitShortcutLabel()} to ${action}` : "";
  const executionControlsDisabled =
    (executionReadOnly ?? false) || hasPendingInteraction;
  const footerStart = useMemo(
    () => (
      <ExecutionControls {...execution} disabled={executionControlsDisabled} />
    ),
    [execution, executionControlsDisabled],
  );
  const { permissionDisplayOverride, permissionPickerDisabledByPlanMode } =
    usePromptModePermissionDisplay({
      execution,
      value: composer.message,
      mentionRanges: composer.mentionRanges,
      activePromptMode,
    });
  const permissionReadOnlyResolved =
    (permissionReadOnly ?? false) || hasPendingInteraction;
  const permissionPickerDisabled =
    permissionReadOnlyResolved || permissionPickerDisabledByPlanMode;
  const permissionControl = useMemo(
    () => (
      <PermissionModePicker
        value={permission.value}
        options={permission.options}
        onChange={permission.onChange}
        supported={permission.supported}
        disabled={permissionPickerDisabled}
        showChevronWhenDisabled={permissionPickerDisabledByPlanMode}
        displayOverride={permissionDisplayOverride}
        className="h-6"
      />
    ),
    [
      permission.onChange,
      permission.options,
      permission.supported,
      permission.value,
      permissionDisplayOverride,
      permissionPickerDisabledByPlanMode,
      permissionPickerDisabled,
    ],
  );
  const stackRef = useRef<HTMLDivElement>(null);
  const lastStackHeightRef = useRef(0);
  const [stackHeight, setStackHeight] = useState(0);
  const applyStackHeight = useCallback((measured: number) => {
    if (lastStackHeightRef.current === measured) return;
    lastStackHeightRef.current = measured;
    setStackHeight(measured);
  }, []);

  useLayoutEffect(() => {
    const element = stackRef.current;
    if (element) {
      applyStackHeight(element.offsetHeight);
    }
  }, [applyStackHeight]);

  useEffect(() => {
    const element = stackRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      if (!entry) return;
      const borderBoxSize = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;
      applyStackHeight(borderBoxSize?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyStackHeight]);
  const elasticTextareaMinHeight =
    stack === null
      ? FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT
      : Math.max(
          FOLLOW_UP_PROMPT_BOX_DEFAULT_MIN_HEIGHT,
          FOLLOW_UP_PROMPT_BOX_ELASTIC_TARGET_HEIGHT - stackHeight,
        );

  const composerElement = (
    <div
      ref={composerInteractionRef}
      className="relative z-20"
      data-follow-up-composer=""
      data-follow-up-composer-expanded={isEditorExpanded ? "" : undefined}
      hidden={hasPendingInteraction}
      onBlurCapture={scheduleCollapseAfterFocusLoss}
      onFocusCapture={handleComposerFocus}
      onPointerDownCapture={handleComposerPointerDown}
    >
      <PromptBoxWithScrollAnchor
        id={id}
        promptBoxRef={promptBoxRef}
        minHeight={elasticTextareaMinHeight}
        value={composer.message}
        mentionRanges={composer.mentionRanges}
        onChange={composer.onChangeMessage}
        onSubmit={composer.onSubmit}
        onEscape={composer.onEscape}
        scrollToBottomOnSubmit={submitMode.kind !== "queue"}
        history={composer.history}
        focusEndKey={focusEndKey}
        placeholder={composer.promptPlaceholder}
        containerCompactPlaceholder={composer.compactPromptPlaceholder}
        heightAnimationKey={isEditorExpanded ? "expanded" : "compact"}
        mentionMenuPlacement="top"
        submission={{
          label: composer.submitLabel,
          icon: composer.submitIcon,
          onStop: onStopRuntime,
          isSubmitting: composer.isFollowUpSubmitting,
          disabled:
            !canSubmit ||
            composer.isFollowUpSubmitting ||
            (steerOnPrimarySubmit && !composer.canModifierSubmit),
          disabledReason: composer.isFollowUpSubmitting
            ? "Submitting..."
            : isLoadingExecutionOptions
              ? "Loading models..."
              : isLoadingPendingInteractions
                ? "Checking pending interactions..."
                : isUnavailable
                  ? "Unavailable"
                  : undefined,
          onModifierSubmit,
          swapSubmitActions: steerOnPrimarySubmit,
          showModifierSubmitAction: submitMode.kind === "queue",
          title: composer.isFollowUpSubmitting
            ? "Submitting..."
            : canSubmit && composer.submitTitle !== undefined
              ? composer.submitTitle
              : isStopping
                ? "Queue for after the stop (Enter)"
                : canQueueFollowUp
                  ? steerOnPrimarySubmit
                    ? isSteeringWhenReady
                      ? `Steer when ready (Enter)${modifierSubmitHint("queue")}`
                      : `Steer current run (Enter)${modifierSubmitHint("queue")}`
                    : `Queue follow-up (Enter)${modifierSubmitHint("steer")}`
                  : isLoadingExecutionOptions
                    ? "Loading models..."
                    : isLoadingPendingInteractions
                      ? "Checking pending interactions..."
                      : isUnavailable
                        ? "Unavailable"
                        : "Submit (Enter)",
          isRunning: canStopRuntime,
        }}
        typeahead={typeahead}
        attachments={attachments}
        promptActions={promptActions}
        compact={compactConfig}
        editorLayout="thread"
        onCollapse={collapseWidePromptBox}
        modeHeader={
          execution.handoff?.active ? (
            <div className="flex min-h-7 items-center gap-1.5 text-xs text-subtle-foreground">
              <Icon
                name="MessageSquarePlus"
                className="size-3.5 shrink-0"
                aria-hidden
              />
              <span>Handoff to new thread</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="ml-auto size-6 shrink-0 text-subtle-foreground"
                onClick={execution.handoff.onExit}
                disabled={executionControlsDisabled}
                aria-label="Exit handoff"
              >
                <Icon name="X" className="size-3" aria-hidden />
              </Button>
            </div>
          ) : null
        }
        footerStart={footerStart}
      />
      {!isWidePromptBoxCollapsed ? (
        <div
          data-follow-up-composer-footer=""
          className="mt-1 flex min-h-6 max-h-6 select-none items-center justify-between gap-2 overflow-hidden pl-[15px] pr-3.5 opacity-100 transition-[max-height,min-height,margin-top,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {environmentSummary}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {permissionControl}
            {contextWindowUsage ? (
              <ThreadContextWindowIndicator usage={contextWindowUsage} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <DefaultFollowUpComposer
      active={composer.threadRuntimeDisplayStatus === "active"}
      composerElement={composerElement}
      isPrimaryComposer={isPrimaryComposer}
      pendingInteraction={pendingInteraction}
      showScrollToBottomButton={showScrollToBottomButton}
      stack={stack}
      stackRef={stackRef}
    />
  );
}

interface DefaultFollowUpComposerProps {
  active: boolean;
  composerElement: ReactNode;
  isPrimaryComposer: boolean;
  pendingInteraction?: ReactNode;
  showScrollToBottomButton: boolean;
  stack: ReactNode | null;
  stackRef: RefObject<HTMLDivElement | null>;
}

function DefaultFollowUpComposer({
  active,
  composerElement,
  isPrimaryComposer,
  pendingInteraction = null,
  showScrollToBottomButton,
  stack,
  stackRef,
}: DefaultFollowUpComposerProps) {
  return (
    <>
      {showScrollToBottomButton ? (
        <ThreadTimelineScrollToBottomButton active={active} />
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
        <div data-follow-up-composer-anchor="">{composerElement}</div>
      </div>
    </>
  );
}

export const FollowUpPromptBox = memo(function FollowUpPromptBox(
  props: FollowUpPromptBoxProps,
) {
  if (props.composer === null) {
    return <FollowUpPromptBoxStackOnly stack={props.stack} />;
  }
  return <FollowUpPromptBoxWithComposer {...props} composer={props.composer} />;
});
