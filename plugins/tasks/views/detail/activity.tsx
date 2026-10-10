import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowUp02Icon from "@hugeicons/core-free-icons/ArrowUp02Icon";
import AttachmentIcon from "@hugeicons/core-free-icons/AttachmentIcon";
import Notification02Icon from "@hugeicons/core-free-icons/Notification02Icon";
import NotificationOff02Icon from "@hugeicons/core-free-icons/NotificationOff02Icon";
import {
  callOp,
  Icon,
  ProviderIcon,
  useBbNavigate,
  useProviders,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  fileLink,
  MarkdownEditor,
  MarkdownView,
} from "../../editor/markdown.js";
import { errorMessage, reportError } from "../../shell/data.js";
import {
  tasks,
  type Attachment,
  type DisplayComment,
} from "../../shared/contract.js";
import { AttachmentsGrid, uploadAttachment } from "./attachments.js";

const AVATAR_CLASS =
  "z-[1] mt-px flex size-[22px] shrink-0 items-center justify-center rounded-full";

export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function AgentAvatar({ comment }: { comment: DisplayComment }) {
  const { providers } = useProviders();
  const known = providers.find(({ id }) => id === comment.provider?.id);
  const provider = known ?? comment.provider;
  const hasArtwork = known?.logoUrl != null || known?.icon != null;
  return (
    <span
      role="img"
      aria-label={known?.displayName ?? provider?.id ?? "Agent"}
      className={
        hasArtwork
          ? `${AVATAR_CLASS} border border-border bg-secondary text-foreground`
          : `${AVATAR_CLASS} bg-primary text-primary-foreground outline outline-2 outline-background`
      }
    >
      {provider === null ? (
        <Icon name="Bot" className="size-3.5" aria-hidden="true" />
      ) : (
        <ProviderIcon
          providerKind="agent"
          provider={provider}
          fallback="Bot"
          className={hasArtwork ? "size-4" : "size-3.5"}
        />
      )}
    </span>
  );
}

function SystemEvent({ comment }: { comment: DisplayComment }) {
  const { body, authorName } = comment;
  const signed = authorName.trim() !== "" && body.endsWith(`by ${authorName}`);
  const text = signed ? body.slice(0, -authorName.length) : body;
  return (
    <div className="relative z-[1] my-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className="mx-[7px] size-2 shrink-0 rounded-full border-2 border-muted bg-card"
      />
      <span className="min-w-0 truncate">
        <span>{text}</span>
        {signed ? (
          <span className="font-medium text-foreground/80">{authorName}</span>
        ) : null}
        <span className="text-muted-foreground/70">
          {" · "}
          {formatRelativeTime(comment.createdAt)}
        </span>
      </span>
    </div>
  );
}

function CommentCard({
  comment,
  attachments,
}: {
  comment: DisplayComment;
  attachments: Attachment[];
}) {
  const agent = comment.kind === "agent";
  const navigate = useBbNavigate();
  const { threadId, threadTitle } = comment;
  return (
    <div className="relative mb-3.5 flex gap-2.5">
      {agent ? (
        <AgentAvatar comment={comment} />
      ) : (
        <span
          aria-hidden
          className={`${AVATAR_CLASS} bg-attention text-2xs font-bold text-background outline outline-2 outline-background`}
        >
          {(comment.authorName.trim()[0] ?? "S").toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-1.5 text-xs">
          {agent && threadId !== null && threadTitle !== null ? (
            <button
              type="button"
              onClick={() => navigate.toThread(threadId)}
              className="truncate font-semibold text-primary hover:underline"
              title={threadTitle}
            >
              {threadTitle}
            </button>
          ) : (
            <span className="font-semibold">{comment.authorName}</span>
          )}
          {agent && comment.presetName ? (
            <span className="rounded-sm bg-secondary px-1 py-px text-2xs font-semibold text-muted-foreground">
              {comment.presetName}
            </span>
          ) : null}
          <time className="text-2xs text-muted-foreground">
            {formatRelativeTime(comment.createdAt)}
          </time>
        </div>
        <MarkdownView value={comment.body} variant="comment" />
        {attachments.length > 0 ? (
          <div className="mt-1.5">
            <AttachmentsGrid attachments={attachments} />
          </div>
        ) : null}
        {comment.kind === "user" && comment.notifiedCount > 0 ? (
          <div className="mt-1 flex items-center gap-1 text-2xs font-medium text-success">
            <HugeiconsIcon icon={Notification02Icon} className="size-2.5" />
            notified the last responding agent
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CommentComposer({
  taskId,
  notifyLabel,
  canNotify,
}: {
  taskId: string;
  notifyLabel: string;
  canNotify: boolean;
}) {
  const [body, setBody] = useState("");
  const [notify, setNotify] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canSend = !sending && body.trim().length > 0;
  const notifying = canNotify && notify;
  const upload = (file: File) => uploadAttachment(file, taskId);

  const send = () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    callOp(tasks.createComment, {
      taskId,
      body: body.trim(),
      notify: notifying,
    })
      .then(
        () => setBody(""),
        (cause: unknown) => setError(errorMessage(cause)),
      )
      .finally(() => setSending(false));
  };

  return (
    <div className="mt-3.5 rounded-lg border border-border bg-card px-3.5 pb-2.5 pt-3 shadow-2xs transition-colors focus-within:border-input focus-within:ring-1 focus-within:ring-ring">
      <MarkdownEditor
        value={body}
        onChange={setBody}
        variant="comment"
        placeholder="Leave a comment… markdown is supported"
        className="min-h-11"
        onSubmit={send}
        onUploadFile={upload}
      />
      {error ? (
        <div className="mt-2 text-xs text-destructive">{error}</div>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                role="switch"
                aria-checked={notifying}
                aria-disabled={!canNotify}
                aria-label={notifyLabel}
                onClick={() => canNotify && setNotify(!notify)}
                className={cn(
                  "mr-auto size-6.5 shrink-0",
                  notifying ? "text-foreground" : "text-muted-foreground",
                  !canNotify &&
                    "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={notifying ? Notification02Icon : NotificationOff02Icon}
                  className="size-3.5"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{notifyLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            for (const file of event.target.files ?? []) {
              upload(file).then(({ url }) => {
                const link = fileLink(file, url);
                setBody((text) => `${text}${text ? "\n" : ""}${link}`);
              }, reportError);
            }
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Attach file"
          className="size-6.5 shrink-0 text-muted-foreground"
          onClick={() => fileInputRef.current?.click()}
        >
          <HugeiconsIcon icon={AttachmentIcon} className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          aria-label="Comment"
          disabled={!canSend}
          className="size-6.5 shrink-0 rounded-md bg-foreground text-background hover:bg-foreground/90"
          onClick={send}
        >
          <HugeiconsIcon icon={ArrowUp02Icon} className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function TaskActivity({
  taskId,
  comments,
  attachments,
}: {
  taskId: string;
  comments: DisplayComment[];
  attachments: Attachment[];
}) {
  const agents = comments.filter((comment) => comment.kind === "agent");
  const latestAgent = agents[agents.length - 1];
  const reachable = latestAgent?.threadId != null && latestAgent.threadTitle;
  const notifyLabel = reachable
    ? `Notify ${latestAgent?.threadTitle}`
    : latestAgent
      ? "Latest responding agent can’t be notified"
      : "No prior agent reply to notify";
  return (
    <section aria-label="Activity">
      <div className="mt-6 border-t border-border-hairline" />
      <h2 className="pb-3 pt-4 text-sm font-semibold">Activity</h2>
      <div
        className={cn(
          "relative",
          comments.length > 0 &&
            "before:absolute before:bottom-1.5 before:left-[11px] before:top-1.5 before:w-px before:bg-border-hairline",
        )}
      >
        {comments.length === 0 ? (
          <div className="text-xs text-muted-foreground">No activity yet.</div>
        ) : null}
        {comments.map((comment) =>
          comment.kind === "system" ? (
            <SystemEvent key={comment.id} comment={comment} />
          ) : (
            <CommentCard
              key={comment.id}
              comment={comment}
              attachments={attachments.filter(
                (attachment) => attachment.commentId === comment.id,
              )}
            />
          ),
        )}
      </div>
      <CommentComposer
        taskId={taskId}
        notifyLabel={notifyLabel}
        canNotify={Boolean(reachable)}
      />
    </section>
  );
}
