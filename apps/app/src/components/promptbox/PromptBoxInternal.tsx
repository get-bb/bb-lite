import { registerPaneComposerFocus } from "@/lib/pane-composer-focus";
import type { PendingAttachmentUpload } from "./useDraftAttachmentUploads";
import type {
  PromptMentionCommandTrigger,
  PromptMentionResource,
  PromptTextMention,
} from "@bb/domain";
import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  arePromptDraftStatesEqual,
  DEFAULT_PLUGIN_MENTION_TRIGGER,
  findActiveTrigger,
  isPromptDraftEmpty,
  orderCommandSuggestions,
  type ActiveTrigger,
  type OrderedMentionSuggestions,
  type PluginMentionTrigger,
  type PromptDraftAttachment,
  type PromptDraftState,
  type ProviderCommandSuggestion,
  type TypeaheadMenuState,
  type TypeaheadTrigger,
} from "@bb/client-core";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import {
  useAppCommandKeyDispatch,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { Button } from "@bb/shared-ui/button";
import {
  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
  COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import {
  getMediaQuerySnapshot,
  REDUCED_MOTION_QUERY,
} from "@bb/shared-ui/hooks/use-media-query";
import { cn } from "@bb/shared-ui/lib/utils";
import { AttachmentPreview } from "./AttachmentPreview";
import {
  PromptBoxActionsMenu,
  type PromptBoxAction,
} from "./PromptBoxActionsMenu";
import {
  PromptMentionLinkContext,
  type PromptMentionLinkResolver,
} from "./editor/prompt-mention-link";
import { promptEditorExtensions } from "./editor/prompt-editor-extensions";
import {
  promptCommandResourceFromSuggestion,
  promptEditorContentFromValue,
  promptEditorCopiedSlice,
  promptEditorInlineContentFromValue,
  promptEditorValueFromDoc,
  promptEditorValueFromSlice,
  promptMentionResourceFromSuggestion,
  type PromptEditorValue,
} from "./editor/prompt-editor-serialization";
import {
  applyPromptParagraphNewline,
  exitTrailingBlockquoteBreak,
  insertParagraphBeforeBlockquote,
  removeEmptyBlockquotes,
} from "./editor/prompt-editor-blocks";
import {
  MentionMenu,
  typeaheadSuggestionKey,
  type TypeaheadSuggestion,
} from "./mentions/MentionMenu";
import { parsePromptMentionClipboardElement } from "./mentions/prompt-mention-clipboard";
import { QueuedEditorTypeaheadLayoutContext } from "./queued-editor-typeahead-layout";
import {
  isModifierSubmitKeyEvent,
  modifierSubmitShortcutAria,
} from "./modifier-submit-shortcut";
import { ComposerSendMenu } from "./ComposerSendMenu";

const PROMPTBOX_MIN_HEIGHT = 68;
const SELECTION_REVEAL_MARGIN = 12;
const COMPACT_PROMPT_ACTION_BUTTON_CLASS =
  "size-8 p-0 transition-all [&_[data-icon-root]]:size-4 max-md:pointer-coarse:size-10";
const SAFARI_POST_COMPOSITION_KEYDOWN_WINDOW_MS = 500;
const PASTE_BLOCK_TAGS =
  /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DD|DL|DT|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|P|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR)$/;
const PASTE_IGNORED_TAGS = /^(HEAD|LINK|META|NOSCRIPT|SCRIPT|STYLE|TITLE)$/;
const ACTIONS_TRANSITION_CLASS =
  "transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none translate-y-0 opacity-100";
const EDITOR_MAX_HEIGHT = {
  thread: "calc(50dvh - 3rem)",
  "root-compose": "calc(70dvh - 3rem)",
};
const INTERACTIVE_TARGET_SELECTOR =
  "a[href],button,input,select,textarea,[contenteditable='true'],[data-prompt-mention='true'],[role='button'],[role='link'],[role='menuitem'],[role='option']";
const EDITOR_CONTENT_CLASS = cn(
  "[&_.ProseMirror]:min-h-full [&_.ProseMirror]:leading-[1.7] [&_.ProseMirror]:outline-none",
  "[&_.ProseMirror_p]:m-0",
  "[&_.ProseMirror_blockquote]:my-1 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-surface-selected-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-subtle-foreground",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:font-light",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-70",
);

export interface PromptBoxSubmissionConfig {
  isSubmitting?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  title?: string;
  isRunning?: boolean;
  onStop?: () => void;
  onModifierSubmit?: () => void;
  swapSubmitActions?: boolean;
  showModifierSubmitAction?: boolean;
}

export interface TypeaheadMentionConfig {
  triggers?: readonly PluginMentionTrigger[];
  results: OrderedMentionSuggestions;
  isLoading: boolean;
  isError: boolean;
  onQueryChange: (
    query: string | null,
    trigger: PluginMentionTrigger | null,
  ) => void;
  resolveLink?: PromptMentionLinkResolver;
}

export interface TypeaheadCommandConfig {
  triggers: readonly PromptMentionCommandTrigger[];
  suggestions: readonly ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  onQueryChange: (
    query: string | null,
    trigger: PromptMentionCommandTrigger | null,
  ) => void;
}

export interface TypeaheadConfig {
  mention: TypeaheadMentionConfig;
  command: TypeaheadCommandConfig;
}

export interface AttachmentsConfig {
  items?: PromptDraftAttachment[];
  pendingUploads?: readonly PendingAttachmentUpload[];
  isAttaching?: boolean;
  error?: string | null;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemove?: (path: string) => void;
  projectId?: string;
}

export interface HistoryConfig {
  currentDraft: PromptDraftState;
  entries: readonly PromptDraftState[];
  onSelectEntry: (draft: PromptDraftState) => void;
  resetKey?: string | number;
}

interface PromptBoxCompactConfig {
  isCompact: boolean;
  placeholder?: string;
}

export interface PromptBoxHandle {
  focusEnd: () => void;
  captureHeightForLayoutChange: () => void;
}

export type { PromptBoxAction } from "./PromptBoxActionsMenu";

export type MentionMenuPlacement = "top" | "bottom";

interface PromptBoxInternalProps {
  id?: string;
  value: string;
  mentionRanges: readonly PromptTextMention[];
  onChange: (value: string, mentionRanges: PromptTextMention[]) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  blurOnPointerSubmit?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  footerStart?: ReactNode;
  submission?: PromptBoxSubmissionConfig;
  minHeight?: number;
  typeahead: TypeaheadConfig;
  mentionMenuPlacement: MentionMenuPlacement;
  attachments?: AttachmentsConfig;
  promptActions?: readonly PromptBoxAction[];
  editorLayout?: keyof typeof EDITOR_MAX_HEIGHT;
  compact?: PromptBoxCompactConfig;
  containerCompactPlaceholder?: string;
  heightAnimationKey?: string | number;
  history?: HistoryConfig;
  promptBoxRef?: Ref<PromptBoxHandle>;
  focusEndKey?: string | number;
}

interface DismissedTriggerRange {
  start: number;
  end: number;
  hasLeftRange: boolean;
}

interface PromptEditorValueKey {
  text: string;
  mentions: readonly PromptTextMention[];
}

interface HistorySession {
  index: number;
  original: PromptDraftState;
  recalled: PromptDraftState;
  resetKey: string | number | undefined;
}

interface PromptEditorHandlers {
  placeholder: string;
  onKeyDown: (
    editor: Editor,
    event: KeyboardEvent,
    isIPadHardwareEnter?: boolean,
  ) => boolean;
  onPaste: (editor: Editor, event: ClipboardEvent, slice: Slice) => boolean;
  onBlur: () => void;
  onUpdate: (editor: Editor, transaction: Transaction) => void;
  onSelectionChange: (editor: Editor) => void;
}

function arePromptEditorValuesEqual(
  left: PromptEditorValueKey,
  right: PromptEditorValueKey,
): boolean {
  return (
    left.text === right.text &&
    (left.mentions === right.mentions ||
      (left.mentions.length === right.mentions.length &&
        left.mentions.every((mention, index) => {
          const other = right.mentions[index]!;
          return (
            mention.start === other.start &&
            mention.end === other.end &&
            JSON.stringify(mention.resource) === JSON.stringify(other.resource)
          );
        })))
  );
}

function trailingTextAfter(doc: ProseMirrorNode, position: number): string {
  const next = doc.resolve(position).nodeAfter;
  const hasWhitespace = next?.isText
    ? /^\s/u.test(next.text ?? "")
    : next?.type.name === "hardBreak";
  return hasWhitespace ? "" : " ";
}

function trimTrailingNewlines(value: PromptEditorValue): PromptEditorValue {
  const text = value.text.replace(/\n+$/u, "");
  return {
    text,
    mentions: value.mentions.filter((mention) => mention.end <= text.length),
  };
}

function promptValueFromHtml(
  html: string,
): PromptEditorValue & { hasMentions: boolean } {
  let text = "";
  let listMarkerPending = false;
  const mentions: PromptTextMention[] = [];
  const append = (value: string) => {
    if (listMarkerPending && value.length > 0) {
      listMarkerPending = false;
      text += "- ";
    }
    text += value;
  };
  const newline = () => {
    text = text.replace(/[ \t]+$/u, "");
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const collapsed = (node.textContent ?? "").replace(/\s+/gu, " ");
      if (collapsed.trim().length > 0) append(collapsed);
      else if (!listMarkerPending && /\S$/u.test(text)) append(" ");
      return;
    }
    if (!(node instanceof Element)) {
      node.childNodes.forEach(visit);
      return;
    }
    const tag = node.tagName.toUpperCase();
    if (PASTE_IGNORED_TAGS.test(tag)) return;
    const mention = parsePromptMentionClipboardElement({ element: node });
    if (mention) {
      append(mention.serializedText);
      mentions.push({
        start: text.length - mention.serializedText.length,
        end: text.length,
        resource: mention.resource,
      });
    } else if (tag === "BR") {
      newline();
    } else if (tag === "PRE") {
      newline();
      append((node.textContent ?? "").replace(/\r\n?/gu, "\n"));
      newline();
    } else {
      const block = PASTE_BLOCK_TAGS.test(tag);
      if (block) newline();
      if (tag === "LI") listMarkerPending = true;
      node.childNodes.forEach(visit);
      if (tag === "LI") listMarkerPending = false;
      if (block) newline();
    }
  };
  new DOMParser()
    .parseFromString(html, "text/html")
    .body.childNodes.forEach(visit);
  if (mentions.length > 0) {
    return { hasMentions: true, ...trimTrailingNewlines({ text, mentions }) };
  }
  return {
    hasMentions: false,
    mentions: [],
    text: text
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .replace(/^\n+|\n+$/gu, ""),
  };
}

function promptValueFromClipboard(
  clipboardData: DataTransfer | null,
): PromptEditorValue | null {
  const html = clipboardData?.getData("text/html") ?? "";
  const rich = html.trim().length > 0 ? promptValueFromHtml(html) : null;
  if (rich?.hasMentions) return rich;
  const plainText = clipboardData?.getData("text/plain") ?? "";
  return plainText.length > 0
    ? { text: plainText.replace(/\r\n?/gu, "\n"), mentions: [] }
    : rich;
}

function sliceHasBlockquote(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    found ||= node.type.name === "blockquote";
    return !found;
  });
  return found;
}

function suppressAnchorActivation(event: Event): boolean {
  if (!(event.target instanceof Element && event.target.closest("a[href]"))) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function isIPadOSWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const isAppleWebKit =
    /Apple Computer/u.test(navigator.vendor) &&
    /\bAppleWebKit\//u.test(navigator.userAgent);
  const isIPad =
    navigator.platform === "iPad" ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 2);
  return isAppleWebKit && isIPad;
}

function focusEditorAtEnd(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.atEnd(editor.state.doc))
      .scrollIntoView(),
  );
  editor.view.focus();
}

function blurPromptEditor(editor: Editor | null): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

function commandOfAction(action: PromptBoxAction) {
  if (action.kind === "skills" || !action.command) return null;
  const { trigger, name, trailingText } = action.command;
  return {
    serializedText: `${trigger}${name}`,
    trailingText,
    resource: {
      kind: "command",
      trigger,
      name,
      source: "command",
      origin: "user",
      label: name,
      argumentHint: null,
    } satisfies PromptMentionResource,
  };
}

function withLeadingCommand(
  value: PromptEditorValueKey,
  command: NonNullable<ReturnType<typeof commandOfAction>>,
): PromptEditorValue {
  const leading = value.mentions.find(
    (mention) => mention.resource.kind === "command" && mention.start === 0,
  );
  const rest = value.text.slice(leading?.end ?? 0).trimStart();
  const prefix = `${command.serializedText}${command.trailingText}`;
  const shift = prefix.length - (value.text.length - rest.length);
  return {
    text: `${prefix}${rest}`,
    mentions: [
      {
        start: 0,
        end: command.serializedText.length,
        resource: command.resource,
      },
      ...value.mentions
        .filter((mention) => mention !== leading)
        .map((mention) => ({
          ...mention,
          start: mention.start + shift,
          end: mention.end + shift,
        })),
    ],
  };
}

function usePromptEditor(
  id: string | undefined,
  initialValue: PromptEditorValueKey,
  handlers: PromptEditorHandlers,
): Editor | null {
  const latest = useRef(handlers);
  const editorRef = useRef<Editor | null>(null);
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const postCompositionKeyDownsRef = useRef(new WeakSet<KeyboardEvent>());
  const [options] = useState(() => ({
    extensions: promptEditorExtensions(() => latest.current.placeholder),
    content: promptEditorContentFromValue(initialValue),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": handlers.placeholder,
        "data-placeholder": handlers.placeholder,
        autocomplete: "off",
        class: cn(
          "min-h-full whitespace-pre-wrap break-words outline-none",
          "placeholder:select-none placeholder:text-subtle-foreground",
        ),
        enterkeyhint: "send",
        ...(id ? { id } : {}),
        role: "textbox",
      },
      transformCopied: (slice: Slice, view: EditorView) =>
        promptEditorCopiedSlice(slice, view.state.selection),
      clipboardTextSerializer: (slice: Slice, view: EditorView) =>
        promptEditorValueFromSlice(slice, view.state.schema).text,
      handleDOMEvents: {
        auxclick: (_view: EditorView, event: Event) =>
          suppressAnchorActivation(event),
        click: (_view: EditorView, event: Event) =>
          suppressAnchorActivation(event),
        blur: () => {
          latest.current.onBlur();
          return false;
        },
        compositionend: (view: EditorView, event: Event) => {
          if (view.composing) compositionEndedAtRef.current = event.timeStamp;
          return false;
        },
        keydown: (view: EditorView, event: KeyboardEvent) => {
          if (
            !view.editable ||
            !isIPadOSWebKit() ||
            event.key !== "Enter" ||
            (event.code !== "Enter" && event.code !== "NumpadEnter") ||
            view.composing ||
            event.isComposing ||
            event.keyCode === 229
          ) {
            return false;
          }
          if (
            Math.abs(event.timeStamp - compositionEndedAtRef.current) <
            SAFARI_POST_COMPOSITION_KEYDOWN_WINDOW_MS
          ) {
            compositionEndedAtRef.current = Number.NEGATIVE_INFINITY;
            postCompositionKeyDownsRef.current.add(event);
            return false;
          }
          return (
            editorRef.current !== null &&
            latest.current.onKeyDown(editorRef.current, event, true)
          );
        },
      },
      handleClick: () => {
        if (editorRef.current) {
          latest.current.onSelectionChange(editorRef.current);
        }
        return false;
      },
      handleKeyDown: (_view: EditorView, event: KeyboardEvent) =>
        editorRef.current !== null &&
        !postCompositionKeyDownsRef.current.has(event) &&
        latest.current.onKeyDown(editorRef.current, event),
      handlePaste: (_view: EditorView, event: ClipboardEvent, slice: Slice) =>
        editorRef.current !== null &&
        latest.current.onPaste(editorRef.current, event, slice),
    },
    onSelectionUpdate: (props: {
      editor: Editor;
      transaction: Transaction;
    }) => {
      if (!props.transaction.docChanged) {
        latest.current.onSelectionChange(props.editor);
      }
    },
    onUpdate: (props: { editor: Editor; transaction: Transaction }) =>
      latest.current.onUpdate(props.editor, props.transaction),
  }));
  const editor = useEditor(options, [options]);
  useLayoutEffect(() => {
    latest.current = handlers;
    editorRef.current = editor;
  });
  return editor;
}

function PromptSubmitButton({
  canSubmit,
  disabledReason,
  isBusy,
  isCompact,
  onClick,
  onPointerDown,
  onTouchSubmit,
  title,
}: {
  canSubmit: boolean;
  disabledReason: string | undefined;
  isBusy: boolean;
  isCompact: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTouchSubmit: () => void;
  title: string;
}) {
  const touchRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const suppressTouchClickRef = useRef(false);
  const button = (
    <Button
      data-promptbox-submit-action=""
      type="submit"
      size={isCompact ? "icon" : "sm"}
      variant="default"
      aria-label={title}
      aria-busy={isBusy}
      disabled={!canSubmit}
      onPointerDown={(event) => {
        suppressTouchClickRef.current = false;
        touchRef.current =
          event.pointerType === "touch" && event.isPrimary && event.button === 0
            ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
            : null;
        onPointerDown(event);
      }}
      onPointerMove={(event) => {
        const touch = touchRef.current;
        if (
          touch &&
          touch.pointerId === event.pointerId &&
          Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10
        ) {
          touchRef.current = null;
          suppressTouchClickRef.current = true;
        }
      }}
      onPointerCancel={() => {
        if (touchRef.current) suppressTouchClickRef.current = true;
        touchRef.current = null;
      }}
      onPointerUp={(event) => {
        const touch = touchRef.current;
        touchRef.current = null;
        if (!touch || touch.pointerId !== event.pointerId) return;
        suppressTouchClickRef.current = true;
        if (!canSubmit) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10 ||
          event.clientX < bounds.left ||
          event.clientX >= bounds.right ||
          event.clientY < bounds.top ||
          event.clientY >= bounds.bottom
        ) {
          return;
        }
        onTouchSubmit();
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (suppressTouchClickRef.current && event.detail > 0) {
          event.preventDefault();
          return;
        }
        onClick(event);
      }}
      className={cn(
        isCompact
          ? COMPACT_PROMPT_ACTION_BUTTON_CLASS
          : ["ml-1", COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS],
        "transition-colors",
      )}
    >
      <Icon
        name={isBusy ? "Loading" : "CornerDownLeft"}
        className={cn(
          "size-4",
          isBusy && "animate-spin motion-reduce:animate-none",
        )}
      />
    </Button>
  );
  if (!disabledReason) return button;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-promptbox-submit-disabled-reason=""
            className="inline-flex shrink-0"
          >
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PromptBoxInternal({
  id,
  value,
  mentionRanges,
  onChange,
  onSubmit: onDraftSubmit,
  onEscape,
  blurOnPointerSubmit = false,
  placeholder:
    expandedPlaceholder = "Ask anything. @ to mention files, folders, or sections",
  autoFocus = true,
  footerStart,
  submission = {},
  minHeight = PROMPTBOX_MIN_HEIGHT,
  typeahead,
  mentionMenuPlacement,
  attachments: attachmentConfig = {},
  promptActions,
  editorLayout = "thread",
  compact,
  containerCompactPlaceholder,
  heightAnimationKey,
  history,
  promptBoxRef,
  focusEndKey,
}: PromptBoxInternalProps) {
  const focusComposerShortcut = useAppCommandShortcut("composer.focus");
  const dispatchAppCommandKey = useAppCommandKeyDispatch();
  const reportTypeaheadHeight = useContext(QueuedEditorTypeaheadLayoutContext);
  const {
    isSubmitting = false,
    disabled: submitDisabled = false,
    disabledReason: submitDisabledReason,
    title: submitTitle = "Submit (Enter)",
    isRunning = false,
    onStop,
    onModifierSubmit: onImmediateSubmit,
    swapSubmitActions = false,
    showModifierSubmitAction = false,
  } = submission;
  const { mention, command } = typeahead;
  const {
    items: attachments = [],
    pendingUploads,
    isAttaching = false,
    error: attachmentError = null,
    onAttachFiles,
    onRemove: onRemoveAttachment,
    projectId: attachmentProjectId,
  } = attachmentConfig;

  const isPointerCoarse = usePointerCoarse();
  const showCompactLayout = compact?.isCompact === true;
  const placeholder = showCompactLayout
    ? (compact.placeholder ?? expandedPlaceholder)
    : expandedPlaceholder;
  const formRef = useRef<HTMLFormElement>(null);
  const blurAfterPointerSubmitRef = useRef(false);
  const typeaheadMenuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const heightAnimationFromRef = useRef<number | null>(null);
  const revealFrameRef = useRef<number | null>(null);
  const pendingFocusEndRef = useRef(false);
  const lastFocusEndKeyRef = useRef(focusEndKey);
  const stopGestureButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastSyncedRef = useRef<PromptEditorValueKey>({
    text: value,
    mentions: mentionRanges,
  });
  const dismissedTriggerRef = useRef<DismissedTriggerRange | null>(null);
  const restoringMentionRef = useRef(false);
  const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(
    null,
  );
  const [selected, setSelected] = useState({ triggerKey: "", key: "" });
  const [historySession, setHistorySession] = useState<HistorySession | null>(
    null,
  );
  const [pendingCommandSubmit, setPendingCommandSubmit] = useState(false);

  const triggers: TypeaheadTrigger[] = [
    ...(mention.triggers ?? [DEFAULT_PLUGIN_MENTION_TRIGGER]).map((char) => ({
      char,
      kind: "mention" as const,
    })),
    ...command.triggers.map((char) => ({ char, kind: "command" as const })),
  ];
  const hasSubmittableInput = value.trim().length > 0 || attachments.length > 0;
  const canRun = !isAttaching && !isSubmitting && !submitDisabled;
  const onPrimarySubmit = swapSubmitActions ? onImmediateSubmit : onDraftSubmit;
  const onModifierSubmit = swapSubmitActions
    ? onDraftSubmit
    : onImmediateSubmit;
  const hasModifierSubmit = onModifierSubmit !== undefined;
  const canPrimarySubmit =
    canRun &&
    onPrimarySubmit !== undefined &&
    (swapSubmitActions || hasSubmittableInput);
  const canModifierSubmit =
    canRun && hasModifierSubmit && (!swapSubmitActions || hasSubmittableInput);
  const canSubmit = hasSubmittableInput && canPrimarySubmit;
  const showStop = Boolean(isRunning && onStop && !canSubmit && !isAttaching);
  const submitPrompt = () => {
    const blurAfterSubmit = blurAfterPointerSubmitRef.current;
    blurAfterPointerSubmitRef.current = false;
    if (!canPrimarySubmit) return;
    onPrimarySubmit?.();
    if (blurAfterSubmit) blurPromptEditor(editor);
  };
  const submitModifierPrompt = () => {
    if (canModifierSubmit) onModifierSubmit?.();
  };

  const recalledEntry =
    historySession === null
      ? undefined
      : history?.entries[historySession.index];
  const activeHistorySession =
    historySession !== null &&
    history !== undefined &&
    recalledEntry !== undefined &&
    historySession.resetKey === history.resetKey &&
    arePromptDraftStatesEqual(recalledEntry, historySession.recalled) &&
    arePromptDraftStatesEqual(history.currentDraft, historySession.recalled)
      ? historySession
      : null;

  const triggerKey = activeTrigger
    ? `${activeTrigger.kind}:${activeTrigger.from}:${activeTrigger.to}:${activeTrigger.query}`
    : "";
  const orderedCommands =
    activeTrigger?.kind === "command"
      ? orderCommandSuggestions(command.suggestions, activeTrigger.query)
      : [];
  const activeSuggestions: readonly TypeaheadSuggestion[] =
    activeTrigger?.kind === "command"
      ? orderedCommands
      : activeTrigger?.kind === "mention"
        ? mention.results.suggestions
        : [];
  const selectedIndex = Math.max(
    0,
    selected.triggerKey === triggerKey
      ? activeSuggestions.findIndex(
          (suggestion) => typeaheadSuggestionKey(suggestion) === selected.key,
        )
      : -1,
  );
  const selectSuggestion = (index: number) => {
    const suggestion = activeSuggestions[index];
    if (suggestion) {
      setSelected({ triggerKey, key: typeaheadSuggestionKey(suggestion) });
    }
  };
  const mentionQuery =
    activeTrigger?.kind === "mention" ? activeTrigger.query.trim() : "";
  const typeaheadMenuState: TypeaheadMenuState =
    activeTrigger?.kind === "command"
      ? {
          trigger: "command",
          state: command.isLoading
            ? { kind: "loading" }
            : command.isError
              ? { kind: "error" }
              : { kind: "results", suggestions: orderedCommands },
        }
      : {
          trigger: "mention",
          state:
            mentionQuery.length === 0
              ? { kind: "hint" }
              : mention.isLoading
                ? { kind: "loading" }
                : mention.isError
                  ? { kind: "error" }
                  : { kind: "results", results: mention.results },
        };
  const showTypeaheadMenu =
    activeTrigger !== null &&
    !(
      activeTrigger.kind === "command" &&
      !command.isLoading &&
      !command.isError &&
      command.suggestions.length === 0
    ) &&
    !(
      activeTrigger.kind === "mention" &&
      activeTrigger.char !== DEFAULT_PLUGIN_MENTION_TRIGGER &&
      mentionQuery.length === 0
    );

  const revealSelection = (target: Editor) => {
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
    }
    revealFrameRef.current = requestAnimationFrame(() => {
      revealFrameRef.current = null;
      const container = scrollRef.current;
      const bounds = container?.getBoundingClientRect();
      if (target.isDestroyed || !container || !bounds?.height) return;
      let caret: { top: number; bottom: number };
      try {
        caret = target.view.coordsAtPos(target.state.selection.head);
      } catch {
        return;
      }
      const above = caret.top - bounds.top - SELECTION_REVEAL_MARGIN;
      const below = caret.bottom - bounds.bottom + SELECTION_REVEAL_MARGIN;
      if (above < 0) {
        container.scrollTop = Math.max(0, container.scrollTop + above);
      } else if (below > 0) {
        container.scrollTop += below;
      }
    });
  };
  const focusAtEnd = (target: Editor) => {
    focusEditorAtEnd(target);
    revealSelection(target);
  };

  const clearTypeahead = () => {
    setActiveTrigger(null);
    mention.onQueryChange(null, null);
    command.onQueryChange(null, null);
  };

  const syncTriggerState = (target: Editor) => {
    const caret = target.state.selection.from;
    const detected = findActiveTrigger(target, triggers);
    let dismissed = dismissedTriggerRef.current;
    const restoring = restoringMentionRef.current && dismissed !== null;
    if (dismissed && !restoring) {
      if (!dismissed.hasLeftRange && detected?.from === dismissed.start) {
        dismissed = { ...dismissed, end: Math.max(dismissed.end, caret) };
      }
      const inRange = caret >= dismissed.start && caret <= dismissed.end;
      dismissed = !inRange
        ? { ...dismissed, hasLeftRange: true }
        : dismissed.hasLeftRange
          ? null
          : dismissed;
      dismissedTriggerRef.current = dismissed;
    }
    const suppressed =
      dismissed !== null &&
      !dismissed.hasLeftRange &&
      (restoring || (caret >= dismissed.start && caret <= dismissed.end));
    const next = suppressed ? null : detected;
    if (next === null) {
      clearTypeahead();
      return;
    }
    setActiveTrigger(next);
    if (next.kind === "mention") {
      mention.onQueryChange(next.query, next.char);
      command.onQueryChange(null, null);
    } else {
      command.onQueryChange(next.query, next.char);
      mention.onQueryChange(null, null);
    }
  };

  const refocusAfterApply = (target: Editor, position?: "end") => {
    requestAnimationFrame(() => {
      if (!target.isDestroyed) {
        target.commands.focus(position);
        syncTriggerState(target);
        revealSelection(target);
      }
      restoringMentionRef.current = false;
    });
  };

  const insertMentionPill = (
    target: Editor,
    range: { from: number; to: number },
    resource: PromptMentionResource,
    serializedText: string,
    dismissedEnd: number | null,
  ) => {
    const trailingText = trailingTextAfter(target.state.doc, range.to);
    dismissedTriggerRef.current =
      dismissedEnd === null
        ? null
        : { start: range.from, end: dismissedEnd, hasLeftRange: false };
    restoringMentionRef.current = true;
    clearTypeahead();
    target
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent([
        { type: "mention", attrs: { resource, serializedText } },
        ...(trailingText ? [{ type: "text", text: trailingText }] : []),
      ])
      .run();
    refocusAfterApply(target);
  };

  const applySuggestion = (target: Editor, item: TypeaheadSuggestion) => {
    if (activeTrigger === null) return;
    const range = { from: activeTrigger.from, to: activeTrigger.to };
    if (item.kind === "command" && activeTrigger.kind === "command") {
      insertMentionPill(
        target,
        range,
        promptCommandResourceFromSuggestion(item, activeTrigger.char),
        `${activeTrigger.char}${item.name}`,
        range.from + 1 + trailingTextAfter(target.state.doc, range.to).length,
      );
    } else if (item.kind !== "command" && activeTrigger.kind === "mention") {
      const replacement = item.replacement.trim();
      insertMentionPill(
        target,
        range,
        promptMentionResourceFromSuggestion(item),
        replacement.startsWith(activeTrigger.char)
          ? replacement
          : `${activeTrigger.char}${replacement}`,
        range.from + 2,
      );
    }
  };

  const dismissActiveTrigger = () => {
    if (activeTrigger) {
      dismissedTriggerRef.current = {
        start: activeTrigger.from,
        end: activeTrigger.to,
        hasLeftRange: false,
      };
    }
    clearTypeahead();
  };

  const applyHistoryDraft = (target: Editor, draft: PromptDraftState) => {
    history?.onSelectEntry(draft);
    requestAnimationFrame(() => {
      if (target.isDestroyed) return;
      focusAtEnd(target);
      syncTriggerState(target);
    });
  };

  const handleKeyDown = (
    target: Editor,
    event: KeyboardEvent,
    isIPadHardwareEnter = false,
  ): boolean => {
    if (event.isComposing || event.keyCode === 229) return false;
    if (dispatchAppCommandKey(event)) return true;
    const canSubmitWithEnterKey = !isPointerCoarse || isIPadHardwareEnter;
    const cursor = target.state.selection;
    const hasModifier =
      event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
    const canNavigateHistory =
      history !== undefined &&
      !hasModifier &&
      cursor.empty &&
      cursor.from >= target.state.doc.content.size - 1 &&
      (isPromptDraftEmpty(history.currentDraft) ||
        activeHistorySession !== null);
    const count = activeSuggestions.length;

    if (showTypeaheadMenu) {
      const canNavigate = !hasModifier && !canNavigateHistory && count > 0;
      if (event.key === "ArrowDown" && canNavigate) {
        event.preventDefault();
        selectSuggestion((selectedIndex + 1) % count);
        return true;
      }
      if (event.key === "ArrowUp" && canNavigate) {
        event.preventDefault();
        selectSuggestion((selectedIndex + count - 1) % count);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && count > 0) {
        event.preventDefault();
        const item = activeSuggestions[selectedIndex] ?? activeSuggestions[0]!;
        applySuggestion(target, item);
        if (
          event.key === "Enter" &&
          item.kind === "command" &&
          item.origin === "builtin"
        ) {
          setPendingCommandSubmit(true);
        }
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissActiveTrigger();
        return true;
      }
    }

    if (event.key === "Escape") {
      if (onEscape) onEscape();
      else blurPromptEditor(target);
      return true;
    }

    if (history && canNavigateHistory) {
      if (event.key === "ArrowUp" && history.entries.length > 0) {
        event.preventDefault();
        const index = activeHistorySession
          ? Math.min(activeHistorySession.index + 1, history.entries.length - 1)
          : 0;
        const recalled = history.entries[index]!;
        setHistorySession({
          index,
          original: activeHistorySession?.original ?? history.currentDraft,
          recalled,
          resetKey: history.resetKey,
        });
        applyHistoryDraft(target, recalled);
        return true;
      }
      if (event.key === "ArrowDown" && activeHistorySession) {
        event.preventDefault();
        const index = activeHistorySession.index - 1;
        const recalled = history.entries[index];
        setHistorySession(
          recalled ? { ...activeHistorySession, index, recalled } : null,
        );
        applyHistoryDraft(target, recalled ?? activeHistorySession.original);
        return true;
      }
    }

    if (isModifierSubmitKeyEvent(event) && hasModifierSubmit) {
      event.preventDefault();
      submitModifierPrompt();
      return true;
    }
    if (event.key !== "Enter") return false;
    const unmodified = !event.metaKey && !event.altKey && !event.ctrlKey;
    if (
      unmodified &&
      ((event.shiftKey &&
        (insertParagraphBeforeBlockquote(target) ||
          exitTrailingBlockquoteBreak(target))) ||
        ((event.shiftKey || !canSubmitWithEnterKey) &&
          applyPromptParagraphNewline(target)))
    ) {
      event.preventDefault();
      return true;
    }
    if (event.shiftKey || !canSubmitWithEnterKey) return false;
    event.preventDefault();
    submitPrompt();
    return true;
  };

  const handlePaste = (
    target: Editor,
    event: ClipboardEvent,
    slice: Slice,
  ): boolean => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const attachesFiles = onAttachFiles !== undefined && files.length > 0;
    if (attachesFiles) {
      event.preventDefault();
      void onAttachFiles(files);
    }
    const plainText = (
      event.clipboardData?.getData("text/plain") ?? ""
    ).replace(/\r\n?/gu, "\n");
    const quoteSlice = sliceHasBlockquote(slice);
    if (quoteSlice || /^>(?: |$)/mu.test(plainText)) {
      event.preventDefault();
      const pasted = trimTrailingNewlines(
        quoteSlice
          ? promptEditorValueFromSlice(slice, target.state.schema)
          : { text: plainText, mentions: [] },
      );
      if (pasted.text.length === 0) return true;
      target
        .chain()
        .focus()
        .insertContent(promptEditorContentFromValue(pasted).content ?? [])
        .setMeta("uiEvent", "paste")
        .run();
      const next = trimTrailingNewlines(
        promptEditorValueFromDoc(target.state.doc),
      );
      lastSyncedRef.current = next;
      onChange(next.text, next.mentions);
      return true;
    }
    const pasted = promptValueFromClipboard(event.clipboardData ?? null);
    if (pasted === null) return attachesFiles;
    event.preventDefault();
    if (pasted.text.length > 0) {
      target
        .chain()
        .focus()
        .insertContent(promptEditorInlineContentFromValue(pasted))
        .setMeta("uiEvent", "paste")
        .run();
    }
    return true;
  };

  const editor = usePromptEditor(
    id,
    { text: value, mentions: mentionRanges },
    {
      placeholder,
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      onBlur: () => {
        if (dismissedTriggerRef.current) {
          dismissedTriggerRef.current = {
            ...dismissedTriggerRef.current,
            hasLeftRange: true,
          };
        }
        clearTypeahead();
      },
      onSelectionChange: (target) => {
        syncTriggerState(target);
        revealSelection(target);
      },
      onUpdate: (target, transaction) => {
        const dismissed = dismissedTriggerRef.current;
        if (dismissed && !restoringMentionRef.current) {
          const start = transaction.mapping.mapResult(dismissed.start, 1);
          dismissedTriggerRef.current = start.deleted
            ? null
            : {
                ...dismissed,
                start: start.pos,
                end: transaction.mapping.map(dismissed.end, -1),
              };
        }
        const uiEvent: unknown = transaction.getMeta("uiEvent");
        if (uiEvent === "cut") {
          queueMicrotask(() => {
            if (!target.isDestroyed) removeEmptyBlockquotes(target);
          });
        }
        const next = promptEditorValueFromDoc(target.state.doc);
        lastSyncedRef.current = next;
        onChange(next.text, next.mentions);
        syncTriggerState(target);
        if (uiEvent !== undefined) revealSelection(target);
      },
    },
  );

  const applyPromptAction = (action: PromptBoxAction) => {
    if (action.text.length === 0 || !editor) return;
    const actionCommand = commandOfAction(action);
    if (actionCommand) {
      const next = withLeadingCommand(
        { text: value, mentions: mentionRanges },
        actionCommand,
      );
      onChange(next.text, next.mentions);
      refocusAfterApply(editor, "end");
      return;
    }
    const { from, to, empty } = editor.state.selection;
    const trigger = findActiveTrigger(editor, triggers);
    const alreadyTyped =
      empty &&
      (editor.state.doc
        .textBetween(0, from, "\n", "\n")
        .endsWith(action.text) ||
        (trigger?.kind === "command" &&
          trigger.char === action.text &&
          trigger.to === from));
    if (!alreadyTyped) {
      dismissedTriggerRef.current = null;
      editor
        .chain()
        .focus()
        .deleteRange({ from, to })
        .insertContent(action.text)
        .run();
    }
    refocusAfterApply(editor);
  };

  useImperativeHandle(promptBoxRef, () => ({
    captureHeightForLayoutChange: () => {
      heightAnimationFromRef.current =
        formRef.current?.getBoundingClientRect().height ?? null;
    },
    focusEnd: () => {
      pendingFocusEndRef.current = editor === null && !isPointerCoarse;
      if (editor && !isPointerCoarse) focusAtEnd(editor);
    },
  }));

  useLayoutEffect(() => {
    formRef.current?.style.setProperty(
      "--promptbox-container-compact-placeholder",
      JSON.stringify(containerCompactPlaceholder ?? placeholder),
    );
  }, [containerCompactPlaceholder, placeholder]);

  useLayoutEffect(() => {
    if (!editor) return;
    if (pendingFocusEndRef.current) {
      pendingFocusEndRef.current = false;
      if (!isPointerCoarse) focusAtEnd(editor);
    }
    return registerPaneComposerFocus(editor.view.dom, () => {
      if (!editor.isDestroyed) editor.view.focus();
    });
  }, [editor, isPointerCoarse]);

  useLayoutEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-label", placeholder);
    dom.setAttribute("data-placeholder", placeholder);
    dom.setAttribute("enterkeyhint", isPointerCoarse ? "enter" : "send");
    if (hasModifierSubmit) {
      dom.setAttribute("aria-keyshortcuts", modifierSubmitShortcutAria());
    } else {
      dom.removeAttribute("aria-keyshortcuts");
    }
    editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder, hasModifierSubmit, isPointerCoarse]);

  const focusScopeKey = history?.resetKey;
  useEffect(() => {
    if (!editor) return;
    if (!autoFocus) {
      if (editor.view.dom.contains(document.activeElement)) {
        blurPromptEditor(editor);
      }
      return;
    }
    if (isPointerCoarse) return;
    const handle = requestAnimationFrame(() => {
      if (
        !editor.isDestroyed &&
        !document.activeElement?.closest("[data-sidebar-rename-editor]")
      ) {
        focusAtEnd(editor);
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [autoFocus, editor, focusScopeKey, isPointerCoarse]);

  const syncAfterExternalChange = useEffectEvent((target: Editor) => {
    syncTriggerState(target);
    revealSelection(target);
  });
  useLayoutEffect(() => {
    if (!editor) return;
    const next = { text: value, mentions: mentionRanges };
    if (arePromptEditorValuesEqual(lastSyncedRef.current, next)) return;
    dismissedTriggerRef.current = null;
    lastSyncedRef.current = next;
    editor.commands.setContent(promptEditorContentFromValue(next), {
      emitUpdate: false,
    });
    syncAfterExternalChange(editor);
  }, [editor, mentionRanges, value]);

  useLayoutEffect(() => {
    if (focusEndKey === lastFocusEndKeyRef.current) return;
    if (isPointerCoarse) {
      lastFocusEndKeyRef.current = focusEndKey;
      return;
    }
    if (!editor) return;
    lastFocusEndKeyRef.current = focusEndKey;
    focusAtEnd(editor);
  }, [editor, focusEndKey, isPointerCoarse]);

  useLayoutEffect(() => {
    const fromHeight = heightAnimationFromRef.current;
    const form = formRef.current;
    heightAnimationFromRef.current = null;
    if (fromHeight === null || !form) return;
    if (getMediaQuerySnapshot(REDUCED_MOTION_QUERY)) return;
    const toHeight = form.getBoundingClientRect().height;
    if (Math.abs(toHeight - fromHeight) < 0.5) return;
    const animation = form.animate(
      [
        { height: `${fromHeight}px`, overflow: "hidden" },
        { height: `${toHeight}px`, overflow: "hidden" },
      ],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => animation.cancel();
  }, [heightAnimationKey, showCompactLayout]);

  useLayoutEffect(() => {
    reportTypeaheadHeight?.(
      showTypeaheadMenu
        ? (typeaheadMenuRef.current?.getBoundingClientRect().height ?? 0)
        : 0,
    );
  });
  useEffect(() => () => reportTypeaheadHeight?.(0), [reportTypeaheadHeight]);

  const submitPendingCommand = useEffectEvent(() => {
    setPendingCommandSubmit(false);
    submitPrompt();
  });
  useEffect(() => {
    if (pendingCommandSubmit) submitPendingCommand();
  }, [pendingCommandSubmit]);

  const attachFiles = (files: FileList | null | undefined) => {
    if (onAttachFiles && files && files.length > 0) {
      void onAttachFiles(Array.from(files));
    }
  };
  const handleFormMouseDown = (event: ReactMouseEvent<HTMLFormElement>) => {
    if (
      !editor ||
      !(event.target instanceof Element) ||
      event.target.closest(INTERACTIVE_TARGET_SELECTOR) !== null
    ) {
      return;
    }
    event.preventDefault();
    focusAtEnd(editor);
  };
  const handleSubmitPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    if (
      isPointerCoarse ||
      (editor &&
        !editor.isDestroyed &&
        editor.view.dom.contains(editor.view.dom.ownerDocument.activeElement))
    ) {
      event.preventDefault();
    }
  };
  const attachmentUploadTitle = "Uploading attachments...";

  return (
    <form
      ref={formRef}
      data-promptbox=""
      data-promptbox-compact={showCompactLayout ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        submitPrompt();
      }}
      onMouseDown={handleFormMouseDown}
      onDragOver={(event) => {
        if (onAttachFiles) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onAttachFiles) return;
        event.preventDefault();
        attachFiles(event.dataTransfer?.files);
      }}
      className={cn(
        "group/promptbox relative w-full rounded-xl border border-border bg-background shadow-lift",
        showCompactLayout && "overflow-hidden",
      )}
    >
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          attachFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <div
        data-promptbox-layout=""
        className={cn(
          "grid transition-[grid-template-rows] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
          showCompactLayout && "relative",
        )}
        style={{ gridTemplateRows: "1fr" }}
      >
        <div
          data-promptbox-main=""
          className={cn(
            "min-h-0 overflow-hidden transition-opacity duration-[180ms] motion-reduce:transition-none",
            showCompactLayout && "relative flex h-12 items-center",
          )}
        >
          {showCompactLayout ? (
            <AttachmentPreview
              compact
              attachments={attachments}
              pendingUploads={pendingUploads}
              attachmentProjectId={attachmentProjectId}
              onRemoveAttachment={onRemoveAttachment}
            />
          ) : null}
          <div
            data-promptbox-input-region=""
            className={cn("relative", showCompactLayout && "min-w-0 flex-1")}
          >
            {showCompactLayout ? null : (
              <div data-promptbox-expanded-only="">
                <AppCommandShortcutHint
                  shortcut={focusComposerShortcut}
                  className="absolute right-2 top-2 z-20 group-focus-within/promptbox:hidden"
                />
              </div>
            )}
            <div
              ref={scrollRef}
              data-promptbox-editor-scroll=""
              className={cn(
                "w-full overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 outline-none",
                COARSE_POINTER_TEXT_BASE_CLASS,
                "leading-relaxed",
                showCompactLayout && "h-12 overflow-hidden pb-0 pr-14 pt-0",
              )}
              style={
                showCompactLayout
                  ? { minHeight: "48px", height: "48px", maxHeight: "48px" }
                  : {
                      minHeight: `${minHeight}px`,
                      maxHeight: EDITOR_MAX_HEIGHT[editorLayout],
                    }
              }
            >
              <PromptMentionLinkContext.Provider
                value={mention.resolveLink ?? null}
              >
                <EditorContent
                  editor={editor}
                  data-promptbox-editor-content=""
                  data-promptbox-compact-content={
                    showCompactLayout ? "" : undefined
                  }
                  className={cn(
                    "h-full min-h-full",
                    showCompactLayout && "flex items-center",
                    EDITOR_CONTENT_CLASS,
                  )}
                />
              </PromptMentionLinkContext.Provider>
            </div>
          </div>

          {showTypeaheadMenu ? (
            <div
              ref={typeaheadMenuRef}
              data-promptbox-typeahead-menu=""
              className={cn(
                "absolute -left-px -right-px z-20",
                mentionMenuPlacement === "top"
                  ? "bottom-full mb-2"
                  : "top-full mt-2",
              )}
            >
              <MentionMenu
                state={typeaheadMenuState}
                selectedIndex={selectedIndex}
                onApply={(item) => {
                  if (editor) applySuggestion(editor, item);
                }}
                onDismiss={isPointerCoarse ? dismissActiveTrigger : undefined}
              />
            </div>
          ) : null}

          {showCompactLayout ? null : (
            <div data-promptbox-expanded-only="">
              <AttachmentPreview
                attachments={attachments}
                pendingUploads={pendingUploads}
                attachmentProjectId={attachmentProjectId}
                onRemoveAttachment={onRemoveAttachment}
              />
              {attachmentError ? (
                <div className="mx-3 mb-1 mt-1 text-xs text-destructive">
                  {attachmentError}
                </div>
              ) : null}
            </div>
          )}

          <div
            data-promptbox-action-row=""
            className={cn(
              "relative flex shrink-0 select-none flex-row items-center gap-3 pb-2 pl-3.5 pr-[13px] pt-1.5",
              showCompactLayout && "absolute inset-y-0 right-2 gap-0 p-0",
            )}
          >
            {showCompactLayout ? null : (
              <div
                data-promptbox-expanded-only=""
                data-promptbox-standard-actions=""
                className={cn(
                  "flex min-w-0 flex-1 flex-row items-center gap-1",
                  ACTIONS_TRANSITION_CLASS,
                )}
                aria-live="polite"
              >
                <PromptBoxActionsMenu
                  actions={promptActions}
                  onAttach={
                    onAttachFiles
                      ? () => attachmentInputRef.current?.click()
                      : undefined
                  }
                  onAction={applyPromptAction}
                />
                {footerStart}
              </div>
            )}
            <div
              data-promptbox-standard-actions=""
              className={cn(
                "flex shrink-0 flex-row items-center gap-1",
                ACTIONS_TRANSITION_CLASS,
              )}
            >
              <div
                data-promptbox-submit-group=""
                className="flex shrink-0 flex-row items-center"
              >
                {showStop ? (
                  <Button
                    data-promptbox-submit-action=""
                    type="button"
                    size="icon"
                    variant="secondary"
                    aria-label="Stop run"
                    onPointerDown={(event) => {
                      if (event.button === 0) {
                        stopGestureButtonRef.current = event.currentTarget;
                      }
                    }}
                    onClick={(event) => {
                      const gestureButton = stopGestureButtonRef.current;
                      stopGestureButtonRef.current = null;
                      if (
                        event.detail === 0 ||
                        gestureButton === event.currentTarget
                      ) {
                        onStop?.();
                      }
                    }}
                    className={
                      showCompactLayout
                        ? COMPACT_PROMPT_ACTION_BUTTON_CLASS
                        : COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS
                    }
                  >
                    <Icon
                      name="Square"
                      className="size-3.5 fill-current [&_*]:stroke-0"
                    />
                  </Button>
                ) : (
                  <ComposerSendMenu
                    isPointerCoarse={isPointerCoarse}
                    queue={swapSubmitActions}
                    hasInput={hasSubmittableInput}
                    canSubmit={canSubmit}
                    onSubmit={
                      showModifierSubmitAction && onModifierSubmit
                        ? submitModifierPrompt
                        : undefined
                    }
                  >
                    <PromptSubmitButton
                      canSubmit={canSubmit}
                      disabledReason={
                        canSubmit
                          ? undefined
                          : isAttaching
                            ? attachmentUploadTitle
                            : submitDisabledReason
                      }
                      isBusy={isSubmitting || isAttaching}
                      isCompact={showCompactLayout}
                      onPointerDown={handleSubmitPointerDown}
                      onClick={(event) => {
                        blurAfterPointerSubmitRef.current =
                          blurOnPointerSubmit && event.detail > 0;
                      }}
                      onTouchSubmit={() => {
                        blurAfterPointerSubmitRef.current = blurOnPointerSubmit;
                        submitPrompt();
                      }}
                      title={
                        isAttaching
                          ? attachmentUploadTitle
                          : !canSubmit && submitDisabledReason
                            ? submitDisabledReason
                            : submitTitle
                      }
                    />
                  </ComposerSendMenu>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
