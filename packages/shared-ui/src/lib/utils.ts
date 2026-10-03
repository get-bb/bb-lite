import { type ClassValue, clsx } from "clsx";
import { useCallback, type Ref } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function useComposedRefs<T>(
  first: Ref<T> | undefined,
  second: Ref<T> | undefined,
) {
  return useCallback(
    (node: T | null) => {
      for (const ref of [first, second]) {
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }
    },
    [first, second],
  );
}
