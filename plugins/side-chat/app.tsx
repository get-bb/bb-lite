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

async function openAsTab(sourceThreadId: string, params: PanelParams) {
  const { revision, tabs } = await callOp(threads.tabs, {
    threadId: sourceThreadId,
  });
  const tab = {
    id: `${PLUGIN_ID}:${params.threadId}`,
    kind: "plugin-panel" as const,
    pluginId: PLUGIN_ID,
    actionId: PANEL_ID,
    title: PANEL_TITLE,
    paramsJson: JSON.stringify(params),
  };
  await callOp(threads.updateTabs, {
    threadId: sourceThreadId,
    expectedRevision: revision,
    tabs: [...tabs, tab],
  });
}

function openSideChat(
  sourceThreadId: string,
  anchorText: string,
  open: (params: PanelParams) => Promise<unknown> | unknown,
): Promise<void> {
  const key = `${sourceThreadId}|${anchorText}`;
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const run = callOp(sideChat.create, { sourceThreadId, anchorText })
    .then(async ({ threadId }) => {
      sourceOf.set(threadId, sourceThreadId);
      await open({ threadId, sourceThreadId, sourceMessageText: anchorText });
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
        leadingContent={<ReplyingTo anchorText={data.sourceMessageText} />}
      />
    </div>
  );
}

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
    icon: "MessageSquarePlus",
    isAvailable: (message) =>
      message.threadId !== null && !sourceOf.has(message.threadId),
    run(message) {
      const source = message.threadId;
      if (source === null) return;
      void openSideChat(source, message.text, (params) =>
        openAsTab(source, params),
      );
    },
  });
  bb.add(threadView.messageAction, {
    id: "send-to-main",
    label: "Send to main thread",
    icon: "CornerDownLeft",
    isAvailable: (message) =>
      message.role === "assistant" &&
      message.threadId !== null &&
      sourceOf.has(message.threadId),
    run(message) {
      if (message.threadId !== null) {
        void sendToMain(message.threadId, message.text);
      }
    },
  });
  bb.add(sidePanel.panel, {
    id: PANEL_ID,
    title: "Start side chat",
    icon: "MessageSquarePlus",
    layout: "flush",
    view: SideChatPanel,
    run: ({ threadId, openPanel }) =>
      openSideChat(threadId, "", (params) => {
        const options: PanelOpenOptions = { title: PANEL_TITLE, params };
        openPanel(options);
      }),
  });
}
