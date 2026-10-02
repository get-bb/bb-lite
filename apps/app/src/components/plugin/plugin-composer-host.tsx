import type { PromptDraftState } from "@bb/client-core";

export interface PluginComposerHost {
  getCurrent(): PromptDraftState;
  setDraft(next: PromptDraftState): void;
  isAvailable?(): boolean;
  focus(): void;
}
