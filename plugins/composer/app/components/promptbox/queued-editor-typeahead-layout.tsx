import { createContext } from "react";

export const QueuedEditorTypeaheadLayoutContext = createContext<
  ((menuHeight: number) => void) | null
>(null);
