import { createContext, useContext } from "react";
import type { usePluginPanelActions } from "../plugin/PluginPanelActions";
import type { PromptMentionLinkResolver } from "@bb/app-kit/components/promptbox/editor/prompt-mention-link";
import type { ThreadPanelController } from "./useThreadPanel";

export interface SidePanelHost {
  panel: ThreadPanelController;
  pluginActions: ReturnType<typeof usePluginPanelActions>;
  resolveMentionLink: PromptMentionLinkResolver;
}

export const SidePanelHostContext = createContext<SidePanelHost | null>(null);

export function useSidePanelHost(): SidePanelHost {
  const host = useContext(SidePanelHostContext);
  if (host === null) {
    throw new Error("Side panel tab rendered outside a thread side panel");
  }
  return host;
}
