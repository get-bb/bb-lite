import { useMemo, useSyncExternalStore } from "react";
import type { PromptTextMention } from "@bb/domain";
import type { PromptDraftAttachment, PromptDraftState } from "@bb/client-core";
import {
  arePromptDraftStatesEqual,
  emptyPromptDraftState,
  isPromptDraftEmpty,
  parsePromptDraftStorage,
  serializePromptDraftStorage,
} from "@bb/client-core";

const STORAGE_PREFIX = "bb.promptbox.contents";
const STORAGE_VERSION = "3";

type PromptDraftScope =
  | { kind: "new-thread" }
  | { kind: "thread"; projectId: string; threadId: string };

const EMPTY = emptyPromptDraftState();
const cache = new Map<
  string,
  { raw: string | null; draft: PromptDraftState }
>();
const listeners = new Set<() => void>();
let storedKeys: string | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function storageKeyFor(scope: PromptDraftScope): string {
  if (scope.kind === "new-thread") {
    return `${STORAGE_PREFIX}-draft-${STORAGE_VERSION}`;
  }
  const projectId = encodeURIComponent(scope.projectId.trim());
  const threadId = encodeURIComponent(scope.threadId.trim());
  return `${STORAGE_PREFIX}-${projectId}-${threadId}-${STORAGE_VERSION}`;
}

function read(storageKey: string): PromptDraftState {
  const raw = window.localStorage.getItem(storageKey);
  const cached = cache.get(storageKey);
  if (cached !== undefined && cached.raw === raw) return cached.draft;
  const draft = raw === null ? EMPTY : parsePromptDraftStorage(raw);
  cache.set(storageKey, { raw, draft });
  return draft;
}

function write(storageKey: string, value: PromptDraftState): void {
  const draft = isPromptDraftEmpty(value) ? EMPTY : value;
  const raw = serializePromptDraftStorage(draft);
  try {
    if (raw === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, raw);
  } catch {}
  cache.set(storageKey, {
    raw: window.localStorage.getItem(storageKey),
    draft,
  });
  storedKeys = null;
  for (const listener of listeners) listener();
}

function storedDraftKeys(): string {
  storedKeys ??= Object.keys(window.localStorage)
    .filter((key) => key.startsWith(STORAGE_PREFIX))
    .sort()
    .join("\n");
  return storedKeys;
}

function createAccessor(storageKey: string) {
  const getCurrent = () => read(storageKey);
  const setDraft = (draft: PromptDraftState) => write(storageKey, draft);
  return {
    storageKey,
    getCurrent,
    setDraft,
    setTextAndMentions(text: string, mentions: PromptTextMention[]) {
      setDraft({ ...getCurrent(), text, mentions });
    },
    addAttachment(attachment: PromptDraftAttachment) {
      const draft = getCurrent();
      if (draft.attachments.some((item) => item.path === attachment.path)) {
        return;
      }
      setDraft({ ...draft, attachments: [...draft.attachments, attachment] });
    },
    removeAttachment(path: string) {
      const draft = getCurrent();
      const attachments = draft.attachments.filter(
        (item) => item.path !== path,
      );
      if (attachments.length !== draft.attachments.length) {
        setDraft({ ...draft, attachments });
      }
    },
    clearIfCurrentMatches(expected: PromptDraftState): boolean {
      if (!arePromptDraftStatesEqual(getCurrent(), expected)) return false;
      setDraft(EMPTY);
      return true;
    },
    restoreIfEmpty(draft: PromptDraftState) {
      if (!isPromptDraftEmpty(draft) && isPromptDraftEmpty(getCurrent())) {
        setDraft(draft);
      }
    },
  };
}

const accessors = new Map<string, ReturnType<typeof createAccessor>>();

export function getPromptDraftAccessor(scope: PromptDraftScope) {
  const storageKey = storageKeyFor(scope);
  let accessor = accessors.get(storageKey);
  if (accessor === undefined) {
    accessor = createAccessor(storageKey);
    accessors.set(storageKey, accessor);
  }
  return accessor;
}

export function usePromptDraftStorage(scope: PromptDraftScope) {
  const accessor = getPromptDraftAccessor(scope);
  const draft = useSyncExternalStore(
    subscribe,
    accessor.getCurrent,
    () => EMPTY,
  );
  return useMemo(() => ({ ...accessor, ...draft }), [accessor, draft]);
}

export function usePromptDraftHasInput(scope: PromptDraftScope): boolean {
  const { getCurrent } = getPromptDraftAccessor(scope);
  return useSyncExternalStore(
    subscribe,
    () => !isPromptDraftEmpty(getCurrent()),
    () => false,
  );
}

export function usePromptDraftInputThreadIds(
  threads: readonly { id: string; projectId: string }[],
): ReadonlySet<string> {
  const stored = useSyncExternalStore(subscribe, storedDraftKeys, () => "");
  return useMemo(() => {
    const keys = new Set(stored.split("\n"));
    return new Set(
      threads
        .filter(({ id, projectId }) =>
          keys.has(storageKeyFor({ kind: "thread", projectId, threadId: id })),
        )
        .map((thread) => thread.id),
    );
  }, [stored, threads]);
}
