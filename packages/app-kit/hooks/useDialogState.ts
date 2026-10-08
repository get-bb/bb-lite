import { useMemo, useState } from "react";

export function useDialogState<T>() {
  const [target, setTarget] = useState<T | null>(null);
  const [handlers] = useState(() => ({
    onOpen: (next: T) => setTarget(next),
    onClose: () => setTarget(null),
    onOpenChange: (open: boolean) => {
      if (!open) setTarget(null);
    },
  }));
  return useMemo(() => ({ ...handlers, target }), [handlers, target]);
}
