import type { PromptDraftState } from "@bb/client-core";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";

type DraftUpdate = Pick<PromptDraftState, "text" | "mentions"> &
  Partial<Pick<PromptDraftState, "attachments">>;

export function createCoreComposerActions(source: PluginComposerHost) {
  const requireAvailable = () => {
    if (source.isAvailable?.() === false)
      throw new Error("This composer is no longer available.");
  };
  const replace = (
    next: DraftUpdate | ((current: PromptDraftState) => DraftUpdate),
  ) => {
    requireAvailable();
    const current = source.getCurrent();
    const result = typeof next === "function" ? next(current) : next;
    if (result !== current) source.setDraft({ ...current, ...result });
  };
  return {
    replace,
    restoreDraft: (draft: PromptDraftState) => replace(draft),
    focus() {
      requireAvailable();
      source.focus();
    },
  };
}
