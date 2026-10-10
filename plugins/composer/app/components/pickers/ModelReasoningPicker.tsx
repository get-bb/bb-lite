import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaRole,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SystemExecutionOptionsModelLoadError } from "@bb/server-contract";
import {
  compareReasoningLevels,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_PROVIDER_TAB_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@bb/shared-ui/popover";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { Switch } from "@bb/shared-ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@bb/shared-ui/toggle-group";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "@bb/shared-ui/menu-item-hover";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { type PickerOption } from "@bb/app-kit/components/pickers/OptionPicker";
import type {
  SessionOptionChoice,
  SessionOptionMenuSection,
} from "./SessionOptionsMenu";
import {
  PickerLoadingRows,
  searchPickerOptions,
  useResetPickerScroll,
} from "./picker-search";
import {
  formatModelLoadErrorText,
  formatModelLoadErrorTitle,
  ModelLoadErrorMessage,
} from "./model-load-error-message";
import {
  useAppCommandContext,
  useAppCommandHandler,
  useAppCommandShortcut,
  useIndexedAppCommandHandlers,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@bb/app-kit/components/commands/AppCommandShortcutHint";
import { isEditableKeyboardTarget } from "@bb/app-kit/lib/app-keybindings";
import { useOptionalPaneContext } from "@bb/app-kit/views/thread-detail/PaneContext";

export interface ProviderPickerOption extends PickerOption<string> {
  brandPrefix?: string;
  installUrl?: string;
}

type ModelPickerOption = PickerOption<string>;

const FAILED_TO_LOAD_MODELS_LABEL = "Failed to load models";
const MODEL_SEARCH_MIN_OPTIONS = 5;
const MENU_WIDTH_CLASS_NAME = "w-max min-w-64 max-w-80";
const MENU_ROW_CLASS_NAME =
  "relative flex w-full cursor-default select-none items-center rounded-sm px-2 text-xs outline-none hover:bg-state-hover hover:text-foreground";
const MODEL_CYCLE_COMMANDS = [
  "modelPicker.cycleModel",
  "modelPicker.cycleModelBackward",
] as const;
const PROVIDER_CYCLE_COMMANDS = [
  "modelPicker.cycleProvider",
  "modelPicker.cycleProviderBackward",
] as const;
const REASONING_CYCLE_COMMANDS = [
  "modelPicker.cycleReasoning",
  "modelPicker.cycleReasoningBackward",
] as const;

function stripModelBrandPrefix(
  label: string,
  brandPrefix: string | undefined,
): string {
  return brandPrefix &&
    label.toLowerCase().startsWith(brandPrefix.toLowerCase())
    ? label.slice(brandPrefix.length).trimStart()
    : label;
}

function splitModelLabelTag(label: string): {
  base: string;
  tag: string | null;
} {
  const match = label.match(/^(.*\S)\s*\(([^()]+)\)$/u);
  return match
    ? { base: match[1]!, tag: match[2]! }
    : { base: label, tag: null };
}

function cycleValue<T extends string>(
  options: readonly PickerOption<T>[],
  current: T,
  step: 1 | -1,
): T | null {
  const index = options.findIndex((option) => option.value === current);
  const next =
    options[
      index < 0 && step < 0
        ? options.length - 1
        : (index + step + options.length) % options.length
    ];
  return next === undefined || next.value === current ? null : next.value;
}

function cycleReasoningValue(
  options: readonly PickerOption<ReasoningLevel>[],
  current: ReasoningLevel,
  step: 1 | -1,
): ReasoningLevel | null {
  const supported = options
    .map((option) => option.value)
    .sort(compareReasoningLevels);
  const index = supported.indexOf(current);
  const offered = index !== -1;
  const neighbour =
    supported[(index + step + supported.length) % supported.length];
  const higher = supported.find(
    (level) => compareReasoningLevels(level, current) > 0,
  );
  const lower = [...supported]
    .reverse()
    .find((level) => compareReasoningLevels(level, current) < 0);
  const ranked =
    step > 0 ? (higher ?? supported[0]) : (lower ?? supported.at(-1));
  const next = offered ? neighbour : ranked;
  return next === undefined || next === current ? null : next;
}

const NO_AGENT_SECTIONS: readonly SessionOptionMenuSection[] = [];
function ignoreAgentOptionChange(): void {}

const SINGLE_ROW_REASONING_LEVELS = 6;
const WIDE_REASONING_LABEL_LENGTH = 12;

function reasoningLadderClassName(
  options: readonly PickerOption<ReasoningLevel>[],
): string {
  if (options.length <= SINGLE_ROW_REASONING_LEVELS) {
    return "flex flex-wrap gap-1";
  }
  return options.some(
    (option) => option.label.length > WIDE_REASONING_LABEL_LENGTH,
  )
    ? "grid grid-cols-3 gap-1"
    : "grid grid-cols-4 gap-1";
}

export interface ExecutionPermissionConfig {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
}

export interface ExecutionControlsProps {
  provider: {
    options?: readonly ProviderPickerOption[];
    selectedId?: string;
    onChange?: (value: string) => void;
    hasMultiple?: boolean;
  };
  model: {
    active?: { model: string } | null;
    selected: string;
    options: readonly ModelPickerOption[];
    moreOptions: readonly ModelPickerOption[];
    isLoading: boolean;
    loadFailed: boolean;
    loadError?: SystemExecutionOptionsModelLoadError | null;
    onChange: (value: string) => void;
  };
  serviceTier?: {
    value?: ServiceTier;
    onChange: (value: ServiceTier | undefined) => void;
    supported: boolean;
    fastLabel?: string;
  };
  reasoning: {
    value: ReasoningLevel;
    options: readonly PickerOption<ReasoningLevel>[];
    onChange: (value: ReasoningLevel) => void;
  };
  agentSections?: readonly SessionOptionMenuSection[];
  onAgentOptionChange?: (optionId: string, value: SessionOptionChoice) => void;
  disabled?: boolean;
}

export function ModelReasoningPicker({
  provider: providerConfig,
  model,
  serviceTier,
  reasoning,
  agentSections = NO_AGENT_SECTIONS,
  onAgentOptionChange = ignoreAgentOptionChange,
  disabled = false,
  commandShortcutsEnabled = true,
  className,
  muted,
  align = "start",
}: ExecutionControlsProps & {
  commandShortcutsEnabled?: boolean;
  className?: string;
  muted?: boolean;
  align?: "start" | "center" | "end";
}) {
  const providerOptions = providerConfig.options ?? [];
  const selectedProviderId = providerConfig.selectedId ?? "";
  const onSelectedProviderChange = providerConfig.onChange;
  const modelValue = model.active?.model ?? model.selected;
  const modelOptions = model.options;
  const moreModelOptions = model.moreOptions;
  const modelIsLoading = model.isLoading;
  const onModelChange = model.onChange;
  const reasoningValue = reasoning.value;
  const reasoningOptions = reasoning.options;
  const onReasoningChange = reasoning.onChange;
  const fastModeEnabled = serviceTier?.value === "fast";
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showMoreModels, setShowMoreModels] = useState(false);
  const [moreModelsOpen, setMoreModelsOpen] = useState(false);
  const isCompactViewport = useIsCompactViewport();
  const [browsedProviderId, setBrowsedProviderId] =
    useState(selectedProviderId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const registeredToggleShortcut = useAppCommandShortcut("modelPicker.toggle");
  const toggleShortcut = commandShortcutsEnabled
    ? registeredToggleShortcut
    : null;
  const navId = useId();
  const listboxId = `${navId}-listbox`;
  const optionDomId = (index: number) => `${navId}-opt-${index}`;
  const paneContext = useOptionalPaneContext();

  const resetBrowseState = () => {
    setShowMoreModels(false);
    setMoreModelsOpen(false);
    setSearchQuery("");
    setActiveIndex(-1);
  };
  if (browsedProviderId !== selectedProviderId) {
    setBrowsedProviderId(selectedProviderId);
    resetBrowseState();
  }
  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen && !isCompactViewport) resetBrowseState();
  };

  const isSearching = searchQuery.trim().length > 0;
  const provider = providerOptions.find(
    (option) => option.value === selectedProviderId,
  );
  const providerLabel = provider?.label ?? selectedProviderId;
  const selectedModelLabel =
    modelOptions.find((option) => option.value === modelValue)?.label ??
    modelValue;
  const hasSelectedModel = selectedModelLabel.trim().length > 0;
  const hasModelOptions = modelOptions.length > 0;
  const loadError =
    model.loadError?.providerId === selectedProviderId ? model.loadError : null;
  const loadFailed = model.loadFailed || loadError !== null;
  const canSwitchProviders =
    (providerConfig.hasMultiple ?? false) &&
    onSelectedProviderChange !== undefined &&
    providerOptions.length > 1;
  const triggerModelLabel = modelIsLoading
    ? "Loading models..."
    : hasSelectedModel
      ? stripModelBrandPrefix(selectedModelLabel, provider?.brandPrefix)
      : loadFailed && !hasModelOptions && !(loadError && canSwitchProviders)
        ? FAILED_TO_LOAD_MODELS_LABEL
        : loadFailed || hasModelOptions || canSwitchProviders
          ? "Select model"
          : "No models available";
  const triggerModel = splitModelLabelTag(triggerModelLabel);
  const triggerReasoningLabel = hasSelectedModel
    ? (reasoningOptions.find((option) => option.value === reasoningValue)
        ?.label ?? null)
    : null;
  const isShowingModelError = !modelIsLoading && !hasModelOptions && loadFailed;
  const showProviderTabs =
    canSwitchProviders && (!isShowingModelError || loadError !== null);
  const visibleModelOptions = isSearching
    ? searchPickerOptions({
        options: [...modelOptions, ...moreModelOptions],
        query: searchQuery,
        getLabel: (option) =>
          stripModelBrandPrefix(option.label, provider?.brandPrefix),
        getAliases: (option) => [option.value],
      })
    : modelOptions;
  const highlightedIndex =
    activeIndex < visibleModelOptions.length ? activeIndex : -1;
  const showSelectedFastMode =
    hasSelectedModel && fastModeEnabled && hasModelOptions;
  const showReasoningSection =
    reasoningOptions.length > 0 &&
    hasSelectedModel &&
    !modelIsLoading &&
    !loadFailed;
  const showSearchInput =
    hasModelOptions &&
    !modelIsLoading &&
    modelOptions.length + moreModelOptions.length > MODEL_SEARCH_MIN_OPTIONS;
  const fastModeText = `${serviceTier?.fastLabel ?? "Fast"} mode`;

  const selectModel = (model: string) => {
    onModelChange(model);
    setMoreModelsOpen(false);
  };
  const selectProvider = (providerId: string) => {
    onSelectedProviderChange?.(providerId);
    setSearchQuery("");
    setActiveIndex(-1);
  };
  const selectReasoning = (level: ReasoningLevel) => {
    onReasoningChange(level);
    setMoreModelsOpen(false);
  };

  const ownsChord = (target: EventTarget | null, cycle: boolean): boolean => {
    const composerOf = (element: Element | null) =>
      element?.closest("[data-app-composer]") ?? null;
    const paneOf = (element: Element | null) =>
      element?.closest("[data-split-pane-id]") ?? null;
    const pickerComposer = composerOf(triggerRef.current);
    const caretComposer = composerOf(
      target instanceof HTMLElement ? target : null,
    );
    if (!commandShortcutsEnabled || disabled) return false;
    if (!(paneContext?.isFocused ?? true)) return false;
    if (open) return true;
    if (cycle && caretComposer === null && isEditableKeyboardTarget(target)) {
      return false;
    }
    if (caretComposer !== null && caretComposer === pickerComposer) return true;
    if (
      caretComposer !== null &&
      paneOf(pickerComposer) !== null &&
      paneOf(caretComposer) === paneOf(pickerComposer)
    ) {
      return false;
    }
    return (
      (paneContext?.isSplitPane ?? false) &&
      pickerComposer?.getAttribute("data-app-composer-role") !== "secondary"
    );
  };
  useAppCommandContext(
    "modelPickerOpen",
    commandShortcutsEnabled && open && !disabled,
  );
  useAppCommandHandler(
    "modelPicker.toggle",
    ({ target }) => {
      if (!ownsChord(target, false)) return false;
      changeOpen(!open);
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    MODEL_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsChord(target, true)) return false;
      const next = cycleValue(
        modelOptions.filter((option) => option.disabled !== true),
        modelValue,
        index === 0 ? 1 : -1,
      );
      if (next !== null) onModelChange(next);
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    PROVIDER_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsChord(target, true)) return false;
      const next = canSwitchProviders
        ? cycleValue(providerOptions, selectedProviderId, index === 0 ? 1 : -1)
        : null;
      if (next !== null) selectProvider(next);
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    REASONING_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsChord(target, true)) return false;
      const next = cycleReasoningValue(
        reasoningOptions,
        reasoningValue,
        index === 0 ? 1 : -1,
      );
      if (next !== null) onReasoningChange(next);
      return true;
    },
    50,
    commandShortcutsEnabled,
  );

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const total = visibleModelOptions.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (total === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        const from = current >= total ? -1 : current;
        return from < 0 && step < 0 ? total - 1 : (from + step + total) % total;
      });
    } else if (event.key === "Enter" && highlightedIndex >= 0) {
      event.preventDefault();
      const highlighted = visibleModelOptions[highlightedIndex]!;
      if (highlighted.disabled !== true) selectModel(highlighted.value);
    }
  };
  useEffect(() => {
    if (highlightedIndex >= 0) {
      document
        .getElementById(`${navId}-opt-${highlightedIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, navId]);

  if (
    !modelIsLoading &&
    !model.loadFailed &&
    !hasModelOptions &&
    selectedProviderId.length === 0 &&
    !canSwitchProviders
  ) {
    return null;
  }
  const TriggerIcon =
    hasSelectedModel || modelIsLoading ? provider?.icon : undefined;
  const triggerTitle = [
    `${providerLabel}: ${
      modelIsLoading
        ? "Loading models..."
        : loadFailed
          ? loadError
            ? formatModelLoadErrorText({ error: loadError, providerLabel })
            : "Could not load models."
          : triggerModelLabel
    }`,
    triggerReasoningLabel ? ` · ${triggerReasoningLabel} reasoning` : "",
    showSelectedFastMode ? " (Fast mode)" : "",
  ].join("");
  const trigger = (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      size="sm"
      aria-label={
        toggleShortcut
          ? `Provider, model and reasoning (${toggleShortcut.label})`
          : "Provider, model and reasoning"
      }
      aria-keyshortcuts={toggleShortcut?.ariaKeyshortcuts}
      disabled={disabled}
      className={cn(
        OPTION_BASE_CLASS_NAME,
        OPTION_INTERACTIVE_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        muted && OPTION_MUTED_CLASS_NAME,
        muted && "font-normal",
        disabled && "cursor-default disabled:opacity-100",
        className,
      )}
    >
      <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME} title={triggerTitle}>
        {modelIsLoading ? (
          <>
            {TriggerIcon ? (
              <TriggerIcon className="size-4 shrink-0" />
            ) : (
              <Icon
                name="Spinner"
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            )}
            <span className="sr-only">Loading models</span>
            <Skeleton
              aria-hidden
              data-model-loading-placeholder="trigger-model"
              className="h-3 w-10 shrink-0 rounded-sm"
            />
            <Skeleton
              aria-hidden
              data-model-loading-placeholder="trigger-reasoning"
              className="h-3 w-8 shrink-0 rounded-sm"
            />
          </>
        ) : (
          <>
            {showSelectedFastMode ? (
              <Icon
                name="Zap"
                className="size-3.5 shrink-0 fill-current text-subtle-foreground"
              />
            ) : TriggerIcon ? (
              <TriggerIcon className="size-4 shrink-0" />
            ) : null}
            <span
              className={cn(
                "min-w-0 truncate",
                triggerModelLabel === FAILED_TO_LOAD_MODELS_LABEL &&
                  "text-destructive-text",
              )}
            >
              {triggerModel.base}
            </span>
            {triggerModel.tag ? (
              <span className="shrink-0 text-subtle-foreground">
                {triggerModel.tag}
              </span>
            ) : null}
            {triggerReasoningLabel ? (
              <span
                className="shrink-0 text-subtle-foreground"
                data-promptbox-hide-compact=""
              >
                {triggerReasoningLabel}
              </span>
            ) : null}
          </>
        )}
      </span>
      {disabled ? null : (
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3.5 shrink-0",
            muted ? "text-subtle-foreground/75" : "text-muted-foreground",
          )}
        />
      )}
      <AppCommandShortcutHint
        shortcut={disabled ? null : toggleShortcut}
        className="ml-1"
      />
    </Button>
  );
  if (disabled) return trigger;

  return (
    <Popover open={open} onOpenChange={changeOpen} modal>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        mobileTitle="Model"
        onMobileContentAnimationEnd={(isOpen) => {
          if (!isOpen) resetBrowseState();
        }}
        autoFocusRef={showSearchInput ? searchInputRef : undefined}
        className={cn(
          "flex min-h-0 flex-col p-0",
          MENU_WIDTH_CLASS_NAME,
          isCompactViewport
            ? "overflow-y-hidden"
            : "max-h-[min(var(--available-height),calc(100dvh-0.5rem))] overflow-hidden",
        )}
      >
        {showProviderTabs ? (
          <div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-background px-2.5 pt-1">
            {providerOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                title={option.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (option.value !== selectedProviderId) {
                    selectProvider(option.value);
                  }
                }}
                className={cn(
                  "flex items-center justify-center border-b-2 focus-visible:outline-none",
                  LIST_HOVER_TRANSITION,
                  COARSE_POINTER_PROVIDER_TAB_SIZE_CLASS,
                  option.value === selectedProviderId
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {option.icon ? (
                  <option.icon className={COARSE_POINTER_ICON_SIZE_CLASS} />
                ) : (
                  <span
                    className={cn("font-medium", COARSE_POINTER_TEXT_SM_CLASS)}
                  >
                    {option.label.charAt(0)}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : null}

        {showSearchInput ? (
          <div className="shrink-0 border-b border-border px-1.5 py-1">
            <div className="relative">
              <Icon
                name="Search"
                className="pointer-events-none absolute left-1.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setActiveIndex(-1);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search models"
                aria-label="Search models"
                role="combobox"
                aria-expanded
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={
                  highlightedIndex >= 0
                    ? optionDomId(highlightedIndex)
                    : undefined
                }
                className="h-7 border-0 bg-transparent pl-8 pr-2 text-xs text-foreground placeholder:text-subtle-foreground shadow-none focus-visible:ring-0"
              />
            </div>
          </div>
        ) : null}

        <MenuHoverProvider>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div
              ref={listRef}
              key={selectedProviderId || "no-provider"}
              role={showSearchInput ? "listbox" : undefined}
              id={showSearchInput ? listboxId : undefined}
              aria-label={showSearchInput ? "Models" : undefined}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1 pt-0",
                !isCompactViewport && "max-h-64",
              )}
            >
              {isShowingModelError ? null : (
                <MenuSectionLabel>Model</MenuSectionLabel>
              )}
              {modelIsLoading ? (
                <PickerLoadingRows
                  label="Loading models"
                  rowDataAttribute="data-model-loading-row"
                />
              ) : hasModelOptions ? (
                <>
                  {visibleModelOptions.map((option, index) => (
                    <MenuRowButton
                      key={option.value}
                      id={optionDomId(index)}
                      role={showSearchInput ? "option" : undefined}
                      isActive={highlightedIndex === index}
                      label={stripModelBrandPrefix(
                        option.label,
                        provider?.brandPrefix,
                      )}
                      selected={option.value === modelValue}
                      disabled={option.disabled === true}
                      disabledReason={option.disabledReason}
                      onClick={() => selectModel(option.value)}
                    />
                  ))}
                  {isSearching ||
                  moreModelOptions.length === 0 ? null : isCompactViewport ? (
                    <>
                      <MoreModelsToggleRow
                        expanded={showMoreModels}
                        onToggle={() => setShowMoreModels(!showMoreModels)}
                      />
                      {showMoreModels
                        ? moreModelOptions.map((option) => (
                            <MenuRowButton
                              key={option.value}
                              label={stripModelBrandPrefix(
                                option.label,
                                provider?.brandPrefix,
                              )}
                              selected={option.value === modelValue}
                              disabled={option.disabled === true}
                              disabledReason={option.disabledReason}
                              onClick={() => selectModel(option.value)}
                            />
                          ))
                        : null}
                    </>
                  ) : (
                    <MoreModelsSubmenu
                      open={moreModelsOpen}
                      onOpenChange={setMoreModelsOpen}
                    >
                      {moreModelOptions.map((option) => (
                        <MenuRowButton
                          key={option.value}
                          label={stripModelBrandPrefix(
                            option.label,
                            provider?.brandPrefix,
                          )}
                          selected={option.value === modelValue}
                          disabled={option.disabled === true}
                          disabledReason={option.disabledReason}
                          onClick={() => selectModel(option.value)}
                        />
                      ))}
                    </MoreModelsSubmenu>
                  )}
                  {isSearching && visibleModelOptions.length === 0 ? (
                    <div
                      className={cn(
                        "px-2 text-xs text-muted-foreground",
                        isCompactViewport ? "py-2" : "py-[0.3125rem]",
                      )}
                    >
                      No models match your search
                    </div>
                  ) : null}
                </>
              ) : (
                <div
                  className={cn(
                    "px-2 text-xs leading-relaxed text-muted-foreground",
                    isCompactViewport ? "pb-3 pt-2" : "pb-2 pt-1.5",
                  )}
                  title={
                    loadError
                      ? formatModelLoadErrorTitle({
                          error: loadError,
                          providerLabel,
                        })
                      : undefined
                  }
                >
                  {loadError ? (
                    <ModelLoadErrorMessage
                      error={loadError}
                      providerLabel={providerLabel}
                      installUrl={provider?.installUrl}
                    />
                  ) : loadFailed ? (
                    "Could not load models."
                  ) : (
                    "No models available"
                  )}
                </div>
              )}
            </div>

            {showReasoningSection ? (
              <>
                <div className="shrink-0 border-t border-border" />
                <div className="shrink-0 px-2 py-2.5">
                  <MenuSectionLabel className="mb-2 px-1 py-0">
                    Reasoning
                  </MenuSectionLabel>
                  <ToggleGroup
                    type="single"
                    aria-label="Reasoning"
                    value={reasoningValue}
                    onValueChange={(value) => {
                      const option = reasoningOptions.find(
                        (candidate) => candidate.value === value,
                      );
                      if (option) selectReasoning(option.value);
                    }}
                    className={reasoningLadderClassName(reasoningOptions)}
                  >
                    {reasoningOptions.map((option) => (
                      <ToggleGroupItem
                        key={option.value}
                        value={option.value}
                        aria-label={option.label}
                        className={cn(
                          "h-6 min-w-0 flex-auto shrink-0 whitespace-nowrap rounded-sm px-1 text-xs font-normal shadow-none hover:bg-state-hover hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground data-[state=on]:hover:bg-state-active",
                          isCompactViewport && "h-9 text-sm",
                          LIST_HOVER_TRANSITION,
                        )}
                      >
                        <span className="min-w-0 truncate" title={option.label}>
                          {option.label}
                        </span>
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </>
            ) : null}

            {serviceTier?.supported && hasModelOptions ? (
              <>
                <div className="shrink-0 border-t border-border" />
                <div className="shrink-0 p-1">
                  <div className="flex items-center justify-between gap-3 rounded-sm px-2 py-[0.3125rem] text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon
                        name="Zap"
                        className="size-4 fill-current text-muted-foreground"
                      />
                      <span>{fastModeText}</span>
                    </span>
                    <Switch
                      checked={fastModeEnabled}
                      onCheckedChange={(enabled) =>
                        serviceTier.onChange(enabled ? "fast" : "default")
                      }
                      aria-label={fastModeText}
                      className={cn(LIST_HOVER_TRANSITION, "[&>span]:size-3.5")}
                    />
                  </div>
                </div>
              </>
            ) : null}

            {agentSections.map((section) => {
              const note = section.appliesOnNextTurn ? (
                <span className="ml-1.5 font-normal text-subtle-foreground">
                  from the next turn
                </span>
              ) : null;
              const on = section.items.find((item) => item.value === true);
              if (on !== undefined) {
                return (
                  <Fragment key={section.id}>
                    <div className="shrink-0 border-t border-border" />
                    <div className="shrink-0 p-1">
                      <div
                        className="flex items-center justify-between gap-3 rounded-sm px-2 py-[0.3125rem] text-xs"
                        title={section.description ?? undefined}
                      >
                        <span className="min-w-0 truncate">
                          {section.label}
                          {note}
                        </span>
                        <Switch
                          checked={on.selected}
                          onCheckedChange={(enabled) =>
                            onAgentOptionChange(section.id, enabled)
                          }
                          aria-label={section.label}
                          className={cn(
                            LIST_HOVER_TRANSITION,
                            "[&>span]:size-3.5",
                          )}
                        />
                      </div>
                    </div>
                  </Fragment>
                );
              }
              return (
                <Fragment key={section.id}>
                  <div className="shrink-0 border-t border-border" />
                  <div className="shrink-0 px-2 py-2.5">
                    <MenuSectionLabel className="mb-2 px-1 py-0">
                      {section.label}
                      {note}
                    </MenuSectionLabel>
                    <ToggleGroup
                      type="single"
                      aria-label={section.label}
                      value={
                        section.items.find((item) => item.selected)?.key ?? ""
                      }
                      onValueChange={(key) => {
                        const item = section.items.find(
                          (candidate) => candidate.key === key,
                        );
                        if (item !== undefined) {
                          onAgentOptionChange(section.id, item.value);
                        }
                      }}
                      className="flex flex-wrap gap-1"
                    >
                      {section.items.map((item) => (
                        <ToggleGroupItem
                          key={item.key}
                          value={item.key}
                          title={item.description ?? undefined}
                          className={cn(
                            "h-6 min-w-0 flex-auto shrink-0 whitespace-nowrap rounded-sm px-1 text-xs font-normal shadow-none hover:bg-state-hover hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground data-[state=on]:hover:bg-state-active",
                            isCompactViewport && "h-9 text-sm",
                            LIST_HOVER_TRANSITION,
                          )}
                        >
                          {item.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}

function MenuSectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const isCompactViewport = useIsCompactViewport();
  return (
    <div
      className={cn(
        "sticky top-0 z-10 bg-background px-2 text-xs font-medium text-muted-foreground",
        isCompactViewport ? "pb-1.5 pt-2" : "pb-[0.3125rem] pt-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MoreModelsToggleRow({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { hoverProps } = useMenuItemHover();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        MENU_ROW_CLASS_NAME,
        "gap-1 text-muted-foreground",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        "py-2",
      )}
      {...hoverProps}
    >
      <span>{expanded ? "Fewer models" : "More models"}</span>
      <Icon
        name={expanded ? "ChevronUp" : "ChevronDown"}
        className="size-3.5 shrink-0"
      />
    </button>
  );
}

function MoreModelsSubmenu({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { isLastHovered, hoverProps } = useMenuItemHover();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && !isLastHovered) onOpenChange(false);
  }, [open, isLastHovered, onOpenChange]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onOpenChange(true)}
          onPointerEnter={(event) => {
            hoverProps.onPointerEnter(event);
            onOpenChange(true);
          }}
          onKeyDown={(event) => {
            hoverProps.onKeyDown(event);
            if (["Enter", " ", "Spacebar", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              onOpenChange(true);
              window.setTimeout(() => {
                contentRef.current
                  ?.querySelector<HTMLButtonElement>("button")
                  ?.focus();
              }, 0);
            } else if (event.key === "Escape" || event.key === "ArrowLeft") {
              event.preventDefault();
              onOpenChange(false);
            }
          }}
          className={cn(
            MENU_ROW_CLASS_NAME,
            "gap-1 py-[0.3125rem] text-muted-foreground",
            LIST_HOVER_TRANSITION,
            MENU_ITEM_LAST_HOVERED_CLASS,
          )}
          data-last-hovered={hoverProps["data-last-hovered"]}
        >
          <span>More models</span>
          <Icon name="ChevronRight" className="size-3.5 shrink-0" />
        </button>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={6}
        className={cn(
          "max-h-[min(20rem,var(--available-height),calc(100dvh-0.5rem))] overflow-y-auto overscroll-contain p-1 data-closed:animate-none",
          MENU_WIDTH_CLASS_NAME,
        )}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "ArrowLeft") {
            event.preventDefault();
            onOpenChange(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <MenuHoverProvider>{children}</MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}

function MenuRowButton({
  label,
  selected,
  onClick,
  isActive,
  id,
  role,
  disabled,
  disabledReason,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  isActive?: boolean;
  id?: string;
  role?: AriaRole;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { hoverProps } = useMenuItemHover();
  const isCompactViewport = useIsCompactViewport();
  const { base, tag } = splitModelLabelTag(label);
  return (
    <button
      type="button"
      id={id}
      role={role}
      aria-selected={role === "option" ? Boolean(isActive) : undefined}
      onClick={onClick}
      disabled={disabled}
      title={disabledReason}
      className={cn(
        MENU_ROW_CLASS_NAME,
        "justify-between gap-3",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        isActive && "bg-state-active",
        disabled && "opacity-50",
        isCompactViewport ? "py-2" : "py-[0.3125rem]",
      )}
      {...hoverProps}
    >
      <span className="truncate" title={label}>
        {base}
        {tag ? (
          <span className="ml-1.5 text-subtle-foreground">{tag}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Icon
          name="Check"
          className={cn(
            COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
            "text-subtle-foreground",
            selected ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
    </button>
  );
}
