import { useLayoutEffect, useRef } from "react";
import type { Host } from "@bb/domain";
import { fuzzyMatchText } from "@bb/fuzzy-match";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";

export function searchPickerOptions<T>({
  options,
  query,
  getLabel,
  getAliases,
}: {
  options: readonly T[];
  query: string;
  getLabel: (option: T) => string;
  getAliases?: (option: T) => readonly string[];
}): readonly T[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return options;
  return fuzzyMatchText({
    items: options,
    query: normalizedQuery,
    getText: getLabel,
    getAliases: (option) => getAliases?.(option) ?? [],
    limit: options.length,
  }).map((match) => match.item);
}

export function searchMachineHosts(
  hosts: readonly Host[],
  query: string,
): readonly Host[] {
  return searchPickerOptions({
    options: hosts,
    query,
    getLabel: (host) => host.name,
    getAliases: (host) => [host.id],
  });
}

export function useResetPickerScroll<T extends HTMLElement>(query: string) {
  const scrollRef = useRef<T>(null);
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [query]);
  return scrollRef;
}

export function PickerLoadingRows({
  label,
  rowDataAttribute,
}: {
  label: string;
  rowDataAttribute: `data-${string}`;
}) {
  const isCompactViewport = useIsCompactViewport();
  return (
    <div role="status" aria-label={label} className="pb-1">
      <span className="sr-only">{label}</span>
      {["w-20", "w-28", "w-24", "w-32"].map((widthClassName) => (
        <div
          key={widthClassName}
          {...{ [rowDataAttribute]: "" }}
          aria-hidden
          className={cn(
            "flex items-center rounded-sm px-2",
            isCompactViewport ? "py-2" : "py-[0.3125rem]",
          )}
        >
          <Skeleton
            className={cn("h-3 max-w-[75%] rounded-sm", widthClassName)}
          />
        </div>
      ))}
    </div>
  );
}
