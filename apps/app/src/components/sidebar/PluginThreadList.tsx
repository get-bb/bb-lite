import { useState } from "react";
import { PluginSlotMount } from "@/plugins/mount";
import { useSidebar } from "@/components/ui/sidebar.js";
import { useRouteState } from "@/hooks/useRouteState";
import { resetCrashedSlots } from "@/plugins/registry";
import { appToast } from "@/components/ui/app-toast";
import { ThreadListPlaceholder } from "./SidebarNavigationPlaceholder";
import { useThreadListReplacement } from "./threadListProvider";

export function PluginThreadList({ onNavigate }: { onNavigate: () => void }) {
  const replacement = useThreadListReplacement();
  const { projectId, threadId } = useRouteState();
  const { isCompactViewport } = useSidebar();
  const [attempt, setAttempt] = useState(0);

  if (replacement.kind !== "plugin") {
    return (
      <ThreadListPlaceholder
        state={{
          kind: replacement.kind === "loading" ? "loading" : "missing",
        }}
      />
    );
  }
  const slot = replacement.slot;
  return (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.id}/${slot.generation}/${attempt}`}
      pluginId={slot.pluginId}
      slotKind="threadList"
      slotId={slot.id}
      crashFallback={
        <ThreadListPlaceholder
          state={{
            kind: "crashed",
            pluginTitle: slot.title,
            onReload: () => {
              resetCrashedSlots(slot.pluginId);
              setAttempt((current) => current + 1);
            },
          }}
        />
      }
      onCrash={(crashedPluginId) => {
        appToast.error("Thread list plugin crashed", {
          description: `${slot.title} (${crashedPluginId}) stopped working.`,
        });
      }}
    >
      <slot.component
        activeThreadId={threadId ?? null}
        activeProjectId={projectId ?? null}
        isCompactViewport={isCompactViewport}
        onNavigate={onNavigate}
        searchQuery=""
      />
    </PluginSlotMount>
  );
}
