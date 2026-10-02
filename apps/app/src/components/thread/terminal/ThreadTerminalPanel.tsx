import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TerminalSession } from "@bb/server-contract";
import { sliceUtf16Head } from "@bb/text-utils";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import {
  applyTerminalSessionClose,
  applyTerminalSessionUpsert,
} from "@/hooks/cache-owners/terminal-cache-owner";
import { useRenameTerminal } from "@/hooks/queries/thread-terminal-queries";
import { isVisibleTerminalSession } from "@/lib/terminal-session-visibility";
import { ThreadTerminalView } from "./ThreadTerminalView";

const TERMINAL_TITLE_MAX_LENGTH = 200;
const TERMINAL_TITLE_RENAME_DEBOUNCE_MS = 250;
const SHELL_PATH_TITLE_PATTERN =
  /^[^@\s:]+@[^:\s]+:\s*(~|\.|~\/.*|\/.*|\.\/.*)$/u;

interface ThreadTerminalPanelProps {
  autoFocus?: boolean;
  isPanelOpen: boolean;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  session: TerminalSession | undefined;
}

export function ThreadTerminalPanel({
  autoFocus = false,
  isPanelOpen,
  onAutoFocusHandled,
  onOpenLink,
  session,
}: ThreadTerminalPanelProps) {
  const queryClient = useQueryClient();
  const renameTerminal = useRenameTerminal();
  const renameTimeoutRef = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(renameTimeoutRef.current ?? 0), []);
  const isVisible = session !== undefined && isVisibleTerminalSession(session);

  const handleSessionChange = (next: TerminalSession) => {
    if (next.status === "exited") {
      applyTerminalSessionClose({
        queryClient,
        session: next,
        terminalId: next.id,
      });
    } else {
      applyTerminalSessionUpsert({ queryClient, session: next });
    }
  };
  const handleTitleChange = (rawTitle: string) => {
    const title = sliceUtf16Head(rawTitle.trim(), TERMINAL_TITLE_MAX_LENGTH);
    if (
      session?.status !== "running" ||
      !title ||
      title === session.title ||
      SHELL_PATH_TITLE_PATTERN.test(rawTitle.trim())
    ) {
      return;
    }
    window.clearTimeout(renameTimeoutRef.current ?? 0);
    renameTimeoutRef.current = window.setTimeout(
      () => renameTerminal.mutate({ terminalId: session.id, title }),
      TERMINAL_TITLE_RENAME_DEBOUNCE_MS,
    );
  };

  return (
    <section
      aria-label="Terminal"
      data-app-terminal=""
      className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar"
    >
      <div className="min-h-0 flex-1 overflow-hidden bg-sidebar">
        {!isPanelOpen ? null : !isVisible ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            No terminals
          </div>
        ) : session.status === "starting" ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm">
            <p className="font-medium text-foreground">Terminal starting</p>
          </div>
        ) : (
          <ThreadTerminalView
            autoFocus={autoFocus}
            isPanelOpen={isPanelOpen}
            onAutoFocusHandled={onAutoFocusHandled}
            onOpenLink={onOpenLink}
            onSessionChange={handleSessionChange}
            onTitleChange={handleTitleChange}
            session={session}
          />
        )}
      </div>
    </section>
  );
}
