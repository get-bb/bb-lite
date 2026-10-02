import type { FollowUpSubmitMode } from "@bb/client-core";
import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { PromptTextMention, ThreadRuntimeDisplayStatus } from "@bb/domain";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { modifierSubmitShortcutLabel } from "./modifier-submit-shortcut";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ModelReasoningPicker,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/pickers/ModelReasoningPicker";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { ThreadTimelineScrollToBottomButton } from "@/views/thread-detail/ThreadTimelineScrollToBottomButton";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { ThreadContextWindowIndicator } from "@/components/thread/timeline";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_TRACK_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";

const MIN_HEIGHT = 68;
const COMPOSER_CONTROL_SELECTOR = "button, [role='button'], [aria-haspopup]";
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

function FollowUpPromptBoxWithComposer({
  id,
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
  const expandedRef = useRef(false);
  const [isInteractionExpanded, setIsInteractionExpanded] = useState(false);
  const [stackHeight, setStackHeight] = useState(0);
  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;

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
  const collapseAfterFocusLoss = () => {
    const element = composerRef.current;
    if (
      element &&
      !element.contains(document.activeElement) &&
      !pressedControlRef.current &&
      !element.querySelector('[aria-haspopup][aria-expanded="true"]')
    ) {
      setExpanded(false);
    }
  };
  const handlePointerDown = (event: ReactPointerEvent) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(COMPOSER_CONTROL_SELECTOR)
    ) {
      return;
    }
    pressedControlRef.current = true;
    const release = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.setTimeout(() => {
        pressedControlRef.current = false;
        collapseAfterFocusLoss();
      });
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  };

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
            data-follow-up-composer-expanded={
              isInteractionExpanded || preferExpanded ? "" : undefined
            }
            hidden={hasPendingInteraction}
            onBlurCapture={() =>
              window.requestAnimationFrame(collapseAfterFocusLoss)
            }
            onFocusCapture={() => {
              if (!pressedControlRef.current) setExpanded(true);
            }}
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
              history={composer.history}
              focusEndKey={focusEndKey}
              placeholder={composer.promptPlaceholder}
              containerCompactPlaceholder={composer.compactPromptPlaceholder}
              heightAnimationKey={
                isInteractionExpanded || preferExpanded ? "expanded" : "compact"
              }
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
              footerStart={
                <ModelReasoningPicker
                  {...execution}
                  muted
                  disabled={executionReadOnly || hasPendingInteraction}
                />
              }
            />
            <div
              data-follow-up-composer-footer=""
              className="mt-1 flex min-h-6 max-h-6 select-none items-center justify-between gap-2 overflow-hidden pl-[15px] pr-3.5 opacity-100 transition-[max-height,min-height,margin-top,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                {environmentSummary}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <PermissionModePicker
                  value={permission.value}
                  options={permission.options}
                  onChange={permission.onChange}
                  supported={permission.supported}
                  disabled={permissionReadOnly || hasPendingInteraction}
                  className="h-6"
                />
                {contextWindowUsage ? (
                  <ThreadContextWindowIndicator usage={contextWindowUsage} />
                ) : null}
              </div>
            </div>
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
