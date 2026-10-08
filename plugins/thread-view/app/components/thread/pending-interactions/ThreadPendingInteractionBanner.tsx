import {
  PendingInteractionShell,
  type PendingInteractionSourceThread,
} from "./PendingInteractionShell";
import { useState, type ReactNode } from "react";
import {
  buildPendingInteractionApprovalResolution,
  describePendingInteractionToolUse,
  formatPendingInteractionSubjectDetailLines,
} from "@bb/core-ui";
import { extractShellCommandFromString } from "@bb/thread-view";
import {
  isExtensionKind,
  isPluginPendingInteraction,
  parseExtensionKind,
  type ApprovalPendingInteractionPayload,
  type PendingInteraction,
  type PendingInteractionApprovalDecision,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { MarkdownPreview } from "@bb/app-kit/components/ui/markdown-preview";
import { getDetailScrollMaxHeightClass } from "@bb/app-kit/components/ui/detail-scroll-size";
import { UserQuestionAnswerForm } from "../user-questions/UserQuestionInteractionContent";
import { useResolveThreadPendingInteraction } from "@bb/app-kit/hooks/mutations/thread-interaction-mutations";
import { PluginPendingInteractionComposer } from "../../plugin/PluginPendingInteractionComposer";
import { getMutationErrorMessage } from "@bb/app-kit/lib/mutation-errors";
import {
  presentationIconName,
  presentationTintStyle,
} from "../timeline/presentation-display";
import { cn } from "@bb/shared-ui/lib/utils";

interface BannerProps {
  interaction: PendingInteraction;
  sourceThread?: PendingInteractionSourceThread;
  threadId: string;
}

const COMMAND_PREVIEW_LINE_COUNT = 4;
const APPROVAL_DECISION_ORDER: Record<
  PendingInteractionApprovalDecision,
  number
> = { deny: 0, allow_for_session: 1, allow_once: 2 };
const APPROVAL_DECISION_LABEL = {
  allow_once: "Allow once",
  allow_for_session: "Allow for session",
  deny: "Deny",
} as const;
const APPROVAL_DECISION_VARIANT = {
  allow_once: "default",
  allow_for_session: "outline",
  deny: "ghost",
} as const;

export function ThreadPendingInteractionBanner(props: BannerProps) {
  return <PendingInteractionBanner key={props.interaction.id} {...props} />;
}

function PendingInteractionBanner(props: BannerProps) {
  const { interaction, sourceThread, threadId } = props;
  const { payload } = interaction;
  if (payload.kind === "approval") {
    return <ApprovalBanner {...props} payload={payload} />;
  }
  if (payload.kind === "user_question") {
    const { questions } = payload;
    return (
      <PendingInteractionShell
        label={
          questions.length === 1 ? "Question" : `${questions.length} questions`
        }
        initiallyExpanded
        sourceThread={sourceThread}
        testId="user-question-banner"
      >
        {() => (
          <UserQuestionAnswerForm
            interactionId={interaction.id}
            isResolving={interaction.status === "resolving"}
            questions={questions}
            threadId={threadId}
          />
        )}
      </PendingInteractionShell>
    );
  }
  const { origin } = interaction;
  let renderer: { pluginId: string; rendererId: string };
  if (payload.kind === "plugin") {
    if (origin === undefined || origin.kind !== "plugin") {
      throw new Error("a plugin pending interaction carries a plugin origin");
    }
    renderer = origin;
  } else if (isExtensionKind(payload.kind)) {
    const { pluginId, name } = parseExtensionKind(payload.kind);
    renderer = { pluginId, rendererId: name };
  } else {
    throw new Error(
      `unknown interaction payload kind ${JSON.stringify(payload.kind)}`,
    );
  }
  return (
    <div
      data-testid="plugin-request-banner"
      data-request-kind={`${renderer.pluginId}/${renderer.rendererId}`}
    >
      <PluginPendingInteractionComposer
        sourceThread={sourceThread}
        interaction={interaction}
        request={{
          pluginId: renderer.pluginId,
          rendererId: renderer.rendererId,
          title: payload.title,
          data: payload.data,
        }}
        origin={isPluginPendingInteraction(interaction) ? "plugin" : "provider"}
      />
    </div>
  );
}

function ApprovalBanner({
  interaction,
  payload,
  sourceThread,
  threadId,
}: BannerProps & { payload: ApprovalPendingInteractionPayload }) {
  const resolvePendingInteraction =
    useResolveThreadPendingInteraction(threadId);
  const isResolving = interaction.status === "resolving";
  const { resolution } = interaction;
  const loadingDecision =
    isResolving && resolution && !("kind" in resolution)
      ? resolution.decision
      : null;
  const errorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to resolve pending interaction",
        lifecycleOperation: "resolve_interaction",
      })
    : null;
  const view = buildApprovalSubject(interaction, payload);

  return (
    <PendingInteractionShell
      label="Approval needed"
      title={view.title}
      initiallyExpanded={false}
      errorMessage={errorMessage}
      sourceThread={sourceThread}
      testId="approval-banner"
      footer={[...payload.availableDecisions]
        .sort(
          (left, right) =>
            APPROVAL_DECISION_ORDER[left] - APPROVAL_DECISION_ORDER[right],
        )
        .map((decision, index) => (
          <Button
            key={decision}
            type="button"
            size="sm"
            variant={APPROVAL_DECISION_VARIANT[decision]}
            disabled={resolvePendingInteraction.isPending || isResolving}
            onClick={() => {
              void resolvePendingInteraction
                .mutateAsync({
                  threadId,
                  interactionId: interaction.id,
                  resolution: buildPendingInteractionApprovalResolution(
                    interaction,
                    decision,
                  ),
                })
                .catch(() => {});
            }}
            className={
              index === 0 && decision === "deny" ? "mr-auto" : undefined
            }
          >
            {loadingDecision === decision ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {APPROVAL_DECISION_LABEL[decision]}
          </Button>
        ))}
    >
      {() => view.body}
    </PendingInteractionShell>
  );
}

function ApprovalDetailList({
  className,
  lines,
}: {
  className: string;
  lines: readonly string[];
}) {
  return (
    <ul
      className={cn(
        "min-w-0 max-w-full text-xs text-muted-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function CommandPreview({
  command,
  detailLines,
}: {
  command: string;
  detailLines: readonly string[];
}) {
  const [showsAllLines, setShowsAllLines] = useState(false);
  const lines = command.split("\n");
  const hiddenLineCount = Math.max(
    0,
    lines.length - COMMAND_PREVIEW_LINE_COUNT,
  );
  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card"
      data-testid="command-preview"
    >
      <pre
        className={cn(
          getDetailScrollMaxHeightClass("base"),
          "max-w-full overflow-auto whitespace-pre px-3 py-2 font-mono text-xs leading-relaxed text-foreground",
        )}
      >
        ${" "}
        {showsAllLines || hiddenLineCount === 0
          ? command
          : lines.slice(0, COMMAND_PREVIEW_LINE_COUNT).join("\n")}
      </pre>
      {hiddenLineCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowsAllLines((value) => !value)}
          className="block w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          {showsAllLines
            ? "Show less"
            : hiddenLineCount === 1
              ? "Show 1 more line"
              : `Show ${hiddenLineCount} more lines`}
        </button>
      ) : null}
      {detailLines.length > 0 ? (
        <ApprovalDetailList
          className="border-t border-border px-3 py-2"
          lines={detailLines}
        />
      ) : null}
    </div>
  );
}

function buildApprovalSubject(
  interaction: PendingInteraction,
  payload: ApprovalPendingInteractionPayload,
): { title: string; body: ReactNode } {
  const { subject } = payload;
  if (subject.kind === "tool_use") {
    const ask = describePendingInteractionToolUse({ ...payload, subject });
    return {
      title: ask.title,
      body: (
        <div
          className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-2"
          data-testid="tool-use-ask"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
            <Icon
              name={presentationIconName(ask) ?? "Terminal"}
              fallback="Terminal"
              className="size-3.5 shrink-0"
              style={presentationTintStyle(ask)}
            />
            <span className="min-w-0 truncate font-mono">
              {ask.headline ?? ask.tool}
            </span>
          </div>
          {ask.headline !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Tool: {ask.tool}
            </p>
          ) : null}
          {ask.detail !== null ? (
            <MarkdownPreview
              content={ask.detail}
              className="mt-1 text-xs text-muted-foreground"
              imagePolicy="alt-text"
            />
          ) : null}
        </div>
      ),
    };
  }
  const detailLines = formatPendingInteractionSubjectDetailLines(interaction);
  if (subject.kind === "command") {
    const rawCommand = subject.command;
    const extracted = rawCommand
      ? (extractShellCommandFromString(rawCommand) ?? rawCommand)
      : null;
    const trimmed = extracted?.trim() ?? "";
    const command =
      extracted !== null &&
      trimmed.length > 2 &&
      trimmed.startsWith("`") &&
      trimmed.endsWith("`") &&
      !trimmed.slice(1, -1).includes("`")
        ? trimmed.slice(1, -1)
        : extracted;
    return {
      title: payload.reason ?? "Do you want to run this command?",
      body: command ? (
        <CommandPreview
          command={command}
          detailLines={detailLines
            .filter(
              (line) =>
                !line.startsWith("Command: ") &&
                line !== `Action: ${rawCommand}` &&
                line !== `Action: ${command}`,
            )
            .map((line) =>
              line.startsWith("Cwd: ") ? line.slice("Cwd: ".length) : line,
            )}
        />
      ) : null,
    };
  }
  return {
    title:
      payload.reason ??
      (subject.kind === "file_change"
        ? "Do you want to make these changes?"
        : "Do you want to grant this permission?"),
    body:
      detailLines.length > 0 ? (
        <ApprovalDetailList
          className="rounded-lg border border-border bg-card px-3 py-2"
          lines={detailLines}
        />
      ) : null,
  };
}
