import type { PromptMentionResource, PromptTextMention } from "@bb/domain";
import type { PromptDraftState } from "@bb/client-core";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import {
  createComposerDraftActions,
  type ComposerDraftReplacement,
  type ComposerDraftSnapshot,
  type ComposerMention,
} from "./composer-draft-actions";

function splitPluginItemId(
  pluginId: string,
  itemId: string,
): { provider: string; id: string } {
  const separator = itemId.indexOf(":");
  return separator === -1
    ? { provider: pluginId, id: itemId }
    : { provider: itemId.slice(0, separator), id: itemId.slice(separator + 1) };
}

export function composerMentionFromTextMention({
  start,
  end,
  resource,
}: PromptTextMention): ComposerMention {
  if (resource.kind !== "plugin") return { from: start, to: end, ...resource };
  const { itemId, ...plugin } = resource;
  return {
    from: start,
    to: end,
    ...plugin,
    ...splitPluginItemId(resource.pluginId, itemId),
  };
}

function textMentionFromComposerMention(
  mention: ComposerMention,
): PromptTextMention {
  return {
    start: mention.from,
    end: mention.to,
    resource: resourceOf(mention),
  };
}

function resourceOf(mention: ComposerMention): PromptMentionResource {
  if (mention.kind === "plugin") {
    const { from: _from, to: _to, provider, id, ...plugin } = mention;
    return { ...plugin, itemId: `${provider}:${id}` };
  }
  const { from: _from, to: _to, ...resource } = mention;
  return resource;
}

const composerDrafts = new WeakMap<PromptDraftState, ComposerDraftSnapshot>();

export function composerDraftFromPromptDraft(
  draft: PromptDraftState,
): ComposerDraftSnapshot {
  const cached = composerDrafts.get(draft);
  if (cached !== undefined) return cached;
  const next: ComposerDraftSnapshot = {
    attachments: draft.attachments,
    text: draft.text,
    mentions: draft.mentions.map(composerMentionFromTextMention),
  };
  composerDrafts.set(draft, next);
  return next;
}

type ComposerDraftSource = Pick<
  PluginComposerHost,
  "getCurrent" | "setDraft" | "focus" | "isAvailable"
>;

export function createCoreComposerActions(source: ComposerDraftSource) {
  const target = composerDraftTarget(source);
  const actions = createComposerDraftActions(() => target);
  return {
    get draft() {
      return actions.draft;
    },
    replace: actions.replace,
    focus: actions.focus,
    restoreDraft: (draft: PromptDraftState) =>
      actions.replace(composerDraftFromPromptDraft(draft)),
  };
}

function composerDraftTarget(source: ComposerDraftSource) {
  return {
    getDraft: () => composerDraftFromPromptDraft(source.getCurrent()),
    setDraft: (next: ComposerDraftReplacement) => {
      const current = source.getCurrent();
      source.setDraft({
        ...current,
        text: next.text,
        mentions: next.mentions.map(textMentionFromComposerMention),
        attachments:
          next.attachments === undefined ||
          next.attachments === current.attachments
            ? current.attachments
            : [...next.attachments],
      });
    },
    isAvailable: source.isAvailable ?? (() => true),
    focus: source.focus,
  };
}
