import { useLayoutEffect, useState, type RefObject } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

interface UseOverflowMeasurementArgs {
  elementRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  measurementKey: string;
}

type OverflowMeasurement = "unmeasured" | "fits" | "overflowing";

export function useOverflowMeasurement({
  elementRef,
  enabled,
  measurementKey,
}: UseOverflowMeasurementArgs): OverflowMeasurement {
  const [measurement, setMeasurement] =
    useState<OverflowMeasurement>("unmeasured");

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!enabled || !element) {
      setMeasurement(enabled ? "unmeasured" : "fits");
      return;
    }
    const observer = new ResizeObserver(() => {
      setMeasurement(
        element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1
          ? "overflowing"
          : "fits",
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef, enabled, measurementKey]);

  return measurement;
}

export function useIsOverflowing(args: UseOverflowMeasurementArgs): boolean {
  return useOverflowMeasurement(args) === "overflowing";
}

export function ConversationMessageOverflowToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-1 flex justify-end">
      <button
        type="button"
        onClick={onToggle}
        className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

export function ConversationMessageInlineOverflowToggle({
  buttonBackgroundClassName,
  fadeFromClassName,
  label,
  onToggle,
}: {
  buttonBackgroundClassName: string;
  fadeFromClassName: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[1lh] items-stretch justify-end">
      <span
        className={cn(
          "w-12 bg-gradient-to-l to-transparent",
          fadeFromClassName,
        )}
      />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "pointer-events-auto cursor-pointer whitespace-nowrap pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground",
          buttonBackgroundClassName,
        )}
        aria-expanded={false}
      >
        {label}
      </button>
    </span>
  );
}
