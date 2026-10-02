import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { Icon } from "@bb/shared-ui/icon";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import { TabPill } from "@/components/ui/tab-pill";

export const PALETTE_SECTION_LABEL_CLASS =
  "px-2 py-1 text-xs font-normal leading-5 text-subtle-foreground";

export function PaletteShortcut({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="pointer-events-none inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-state-hover/50 px-1.5 py-1 font-sans text-xs font-normal leading-none tabular-nums text-subtle-foreground"
    >
      {children}
    </kbd>
  );
}

export function PaletteShell({
  activeIndex,
  children,
  idPrefix,
  inputDescription,
  inputLabel,
  listLabel,
  modeLabel,
  onActiveIndexChange,
  onChoose,
  onExitMode,
  onInputChange,
  optionCount,
  placeholder,
  value,
}: {
  activeIndex: number;
  children: ReactNode;
  idPrefix: string;
  inputDescription: string;
  inputLabel: string;
  listLabel: string;
  modeLabel?: string;
  onActiveIndexChange: (index: number) => void;
  onChoose: (index: number, withModifier: boolean) => void;
  onExitMode?: () => void;
  onInputChange: (value: string) => void;
  optionCount: number;
  placeholder: string;
  value: string;
}) {
  const listId = useId();
  const inputDescriptionId = useId();
  const {
    aboveOverflow,
    belowOverflow,
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
  } = useScrollOverflowState<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement>(null);
  const composedListRef = useComposedRefs(listRef, scrollRef);
  const scrollToActiveRef = useRef(false);
  useEffect(() => {
    if (!scrollToActiveRef.current) return;
    scrollToActiveRef.current = false;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, optionCount]);
  const top = aboveOverflow ? "transparent 0, black 1.5rem" : "black 0";
  const bottom = belowOverflow
    ? "black calc(100% - 1.5rem), transparent 100%"
    : "black 100%";
  const resultsMask =
    aboveOverflow || belowOverflow
      ? `linear-gradient(to bottom, ${top}, ${bottom})`
      : undefined;
  const exitMode = (event: {
    preventDefault(): void;
    stopPropagation(): void;
  }) => {
    event.preventDefault();
    event.stopPropagation();
    onExitMode?.();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (
      onExitMode &&
      (event.key === "Escape" ||
        (event.key === "Backspace" && value.length === 0))
    ) {
      exitMode(event);
      return;
    }
    const last = optionCount - 1;
    const target =
      event.key === "ArrowDown"
        ? activeIndex >= last
          ? 0
          : activeIndex + 1
        : event.key === "ArrowUp"
          ? activeIndex <= 0
            ? last
            : activeIndex - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : event.key === "Enter"
                ? activeIndex
                : null;
    if (optionCount === 0 || target === null || target < 0) return;
    event.preventDefault();
    scrollToActiveRef.current = true;
    if (event.key === "Enter") onChoose(target, event.metaKey || event.ctrlKey);
    else onActiveIndexChange(target);
  };

  return (
    <TooltipProvider>
      <div
        className="rounded-t-[inherit] border-b border-border bg-background px-3 py-1"
        data-palette-input-band
      >
        <div className="flex h-10 items-center gap-2" data-palette-input-frame>
          {modeLabel === undefined ? null : (
            <span
              data-palette-mode-chip
              onKeyDown={(event) => {
                if (event.key === "Escape") exitMode(event);
              }}
            >
              <TabPill
                ariaLabel={`${modeLabel} search`}
                label={modeLabel}
                title={modeLabel}
                isActive
                onSelect={() => undefined}
                leadingVisual={<Icon name="Search" aria-hidden />}
                closeAction={{
                  onClose: () => onExitMode?.(),
                  closeLabel: "Return to commands",
                  tooltip: "Return to commands (Esc)",
                }}
              />
            </span>
          )}
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={
              activeIndex < 0 ? undefined : `${idPrefix}-${activeIndex}`
            }
            aria-describedby={inputDescriptionId}
            aria-label={inputLabel}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle-foreground placeholder:font-light placeholder:opacity-70"
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              if (listRef.current !== null) listRef.current.scrollTop = 0;
              onInputChange(event.target.value);
            }}
            onKeyDown={handleKeyDown}
          />
          <span id={inputDescriptionId} className="sr-only">
            {inputDescription}
          </span>
        </div>
      </div>
      <div
        className="relative min-h-0 overflow-hidden rounded-b-[inherit] bg-background"
        data-palette-results-clip
      >
        <div
          ref={composedListRef}
          id={listId}
          role="listbox"
          aria-label={listLabel}
          className="max-h-[min(24rem,50dvh)] overflow-y-auto p-1"
          style={{ WebkitMaskImage: resultsMask, maskImage: resultsMask }}
          data-palette-results-viewport
        >
          <div
            ref={topSentinelRef}
            aria-hidden
            className="-mb-px h-px w-full"
            data-palette-scroll-sentinel="top"
          />
          {children}
          <div
            ref={bottomSentinelRef}
            aria-hidden
            className="h-px w-full"
            data-palette-scroll-sentinel="bottom"
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
