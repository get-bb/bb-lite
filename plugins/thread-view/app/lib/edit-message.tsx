import { useSyncExternalStore } from "react";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import { useThread } from "@bb/app-kit/hooks/queries/thread-queries";
import { useSystemProviders } from "@bb/app-kit/hooks/queries/system-queries";
import { useSlot } from "@bb/app-kit/plugins/slots";
import {
  callOp,
  composer,
  threads,
  type ComposerBanner,
  type ComposerHandle,
  type MessageAction,
} from "@bb/plugin/app";

interface Editing {
  composerKey: string;
  threadId: string;
  seq: number;
}

let editing: Editing | null = null;
const listeners = new Set<() => void>();

function setEditing(next: Editing | null) {
  editing = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stopEditing(target: ComposerHandle) {
  target.setSubmitHandler(null);
  if (editing?.composerKey === target.key) setEditing(null);
}

function startEditing(target: ComposerHandle, seq: number, text: string) {
  const { threadId } = target;
  if (threadId === null) return;
  setEditing({ composerKey: target.key, threadId, seq });
  target.setDraft({ text });
  target.focus();
  target.setSubmitHandler(() => {
    const input = target.input();
    stopEditing(target);
    target.clear();
    callOp(threads.updateMessage, { threadId, seq, input }).catch(
      (error: unknown) =>
        appToast.error(
          `Could not edit the message: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  });
}

export function useEditMessageAction(
  threadId: string | null,
  seq: number | null,
): MessageAction[] {
  const thread = useThread(threadId ?? "").data;
  const providers = useSystemProviders({ enabled: thread !== undefined }).data;
  const composers = useSlot(composer.api).flatMap((api) => api.useComposers());
  const provider = providers?.find(({ id }) => id === thread?.providerId);
  const target = composers.find(
    (handle) => handle.threadId === threadId && handle.surface === "follow-up",
  );
  if (
    provider?.capabilities.fork !== "checkpoint" ||
    target === undefined ||
    seq === null
  ) {
    return [];
  }
  return [
    {
      id: "edit-message",
      label: "Edit and resend from here",
      icon: "Edit",
      isAvailable: (message) => message.role === "user",
      run: (context) => startEditing(target, seq, context.text),
    },
  ];
}

function EditingBanner({ composer: target }: { composer: ComposerHandle }) {
  const current = useSyncExternalStore(subscribe, () => editing);
  if (current?.composerKey !== target.key) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      <span>
        Editing an earlier message; sending replaces it and what follows
      </span>
      <button
        type="button"
        className="cursor-pointer hover:text-foreground"
        onClick={() => {
          stopEditing(target);
          target.clear();
        }}
      >
        Cancel
      </button>
    </div>
  );
}

export const editingBanner: ComposerBanner = {
  id: "thread-view-editing-message",
  isAvailable: (target) => editing?.composerKey === target.key,
  view: EditingBanner,
};
