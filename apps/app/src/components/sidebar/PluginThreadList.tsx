import { useCallback, useState } from "react";
import { PluginSlotMount } from "@/plugins/mount";
import { useRouteState } from "@/hooks/useRouteState";
import {
  resetCrashedSlots,
  type PluginSlot,
  type ResolvedProvider,
} from "@/plugins/registry";
import { appToast } from "@/components/ui/app-toast";
import { ThreadListPlaceholder } from "./ThreadListPlaceholder";

const THREAD_LIST_SLOT_KIND = "threadList";
interface PluginThreadListProps {
  replacement: ResolvedProvider<PluginSlot<"threadLists">>;
}

export function PluginThreadList({ replacement }: PluginThreadListProps) {
  const { projectId, threadId } = useRouteState();
  const [attempt, setAttempt] = useState(0);
  const registration = replacement.kind === "plugin" ? replacement.slot : null;
  const pluginId = registration?.pluginId ?? null;
  const title = registration?.title ?? "Thread list";

  const handleCrash = useCallback(
    (crashedPluginId: string) => {
      appToast.error("Thread list plugin crashed", {
        description: `${title} (${crashedPluginId}) stopped working.`,
      });
    },
    [title],
  );
  const handleReload = useCallback(() => {
    if (pluginId !== null) resetCrashedSlots(pluginId);
    setAttempt((current) => current + 1);
  }, [pluginId]);

  if (registration === null) {
    return (
      <ThreadListPlaceholder
        state={
          replacement.kind === "loading"
            ? { kind: "loading" }
            : { kind: "missing" }
        }
      />
    );
  }
  const List = registration.component;
  return (
    <PluginSlotMount
      key={`${registration.pluginId}/${registration.id}/${registration.generation}/${attempt}`}
      pluginId={registration.pluginId}
      slotKind={THREAD_LIST_SLOT_KIND}
      slotId={registration.id}
      crashFallback={
        <ThreadListPlaceholder
          state={{
            kind: "crashed",
            pluginTitle: title,
            onReload: handleReload,
          }}
        />
      }
      onCrash={handleCrash}
    >
      <List
        activeThreadId={threadId ?? null}
        activeProjectId={projectId ?? null}
        searchQuery=""
      />
    </PluginSlotMount>
  );
}
