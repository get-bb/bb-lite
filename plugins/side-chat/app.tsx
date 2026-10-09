import { useEffect, useState } from "react";
import { appToast } from "@bb/app-kit/components/ui/app-toast";
import {
  callOp,
  Icon,
  Markdown,
  sidePanel,
  ThreadChat,
  threads,
  threadView,
  type MessageAction,
  type PanelOpenOptions,
  type PluginAppApi,
  type SidePanelPanelProps,
} from "@bb/plugin/app";
import { z } from "zod";
import { sideChat } from "./contract";

const PLUGIN_ID = "side-chat";
const PANEL_ID = "side-chat";
const PANEL_TITLE = "Side chat";

const panelParams = z.object({
  threadId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  sourceMessageText: z.string().catch(""),
});
type PanelParams = z.infer<typeof panelParams>;

const sourceOf = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function openSideChat(
  sourceThreadId: string,
  anchorText: string,
  sourceSeqEnd: number | null,
  open: (options: PanelOpenOptions) => unknown,
): Promise<void> {
  const key = `${sourceThreadId}|${sourceSeqEnd ?? "tip"}|${anchorText}`;
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const run = callOp(sideChat.create, {
    sourceThreadId,
    anchorText,
    ...(sourceSeqEnd === null ? {} : { sourceSeqEnd }),
  })
    .then(async ({ threadId }) => {
      sourceOf.set(threadId, sourceThreadId);
      const params: PanelParams = {
        threadId,
        sourceThreadId,
        sourceMessageText: anchorText,
      };
      open({ title: PANEL_TITLE, params });
    })
    .catch((error: unknown) => {
      appToast.error(`Failed to start side chat: ${errorText(error)}`);
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

function ReplyingTo({ anchorText }: { anchorText: string }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = anchorText.trim();
  if (trimmed === "") return null;
  return (
    <div className="mx-1 mb-2 flex flex-col items-start gap-1">
      <span className="text-xs leading-none text-muted-foreground">
        <Icon
          name="CornerDownRight"
          className="mr-1 inline-block size-3 align-middle"
        />
        Replying to
      </span>
      <div
        className="max-w-full cursor-pointer rounded-md bg-surface-recessed p-1.5 text-xs leading-5 text-foreground"
        role="button"
        title={expanded ? "Collapse" : "Show full message"}
        onClick={() => setExpanded((value) => !value)}
      >
        <div
          className={
            expanded ? "break-words" : "max-h-20 overflow-hidden break-words"
          }
        >
          <Markdown content={trimmed} className="text-xs leading-5" />
        </div>
      </div>
    </div>
  );
}

function SideChatPanel({ params }: SidePanelPanelProps) {
  const parsed = panelParams.safeParse(params);
  const data = parsed.success ? parsed.data : null;
  const threadId = data?.threadId ?? null;
  const sourceThreadId = data?.sourceThreadId ?? null;
  useEffect(() => {
    if (threadId !== null && sourceThreadId !== null) {
      sourceOf.set(threadId, sourceThreadId);
    }
  }, [threadId, sourceThreadId]);
  if (data === null) {
    return (
      <div className="p-3 text-sm text-muted-foreground" role="alert">
        This side chat tab is missing its thread reference.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadChat
        threadId={data.threadId}
        variant="compact"
        layout="contained"
        className="min-h-0 flex-1"
        permissionPolicy="editable"
        leadingContent={<ReplyingTo anchorText={data.sourceMessageText} />}
        messageActions={sendToMainActions}
      />
    </div>
  );
}

const sendToMainActions: readonly MessageAction[] = [
  {
    id: "send-to-main",
    label: "Send to main thread",
    icon: "ArrowTurnBackward",
    isAvailable: (message) => message.role === "assistant",
    run(message) {
      if (message.threadId !== null) {
        void sendToMain(message.threadId, message.text);
      }
    },
  },
];

async function sendToMain(threadId: string, text: string) {
  const sourceThreadId = sourceOf.get(threadId);
  const trimmed = text.trim();
  if (sourceThreadId === undefined || trimmed === "") return;
  try {
    await callOp(threads.createQueuedMessage, {
      threadId: sourceThreadId,
      input: [{ type: "text", text: trimmed, mentions: [] }],
      senderThreadId: threadId,
    });
    appToast.success("Sent to main thread");
  } catch (error) {
    appToast.error(`Failed to send to main thread: ${errorText(error)}`);
  }
}

export default function sideChatApp(bb: PluginAppApi) {
  bb.add(threadView.messageAction, {
    id: "reply-in-side-chat",
    label: "Reply in side chat",
    icon: "SideChat",
    isAvailable: (message) =>
      message.threadId !== null && !sourceOf.has(message.threadId),
    run(context) {
      const source = context.threadId;
      if (source === null) return;
      void openSideChat(
        source,
        context.selectedText ?? context.text,
        context.seq,
        (options) => context.openPanel({ actionId: PANEL_ID, ...options }),
      );
    },
  });
  bb.add(sidePanel.panel, {
    id: PANEL_ID,
    title: "Start side chat",
    icon: "SideChat",
    layout: "flush",
    view: SideChatPanel,
    run: ({ threadId, openPanel }) =>
      openSideChat(threadId, "", null, openPanel),
  });
}
