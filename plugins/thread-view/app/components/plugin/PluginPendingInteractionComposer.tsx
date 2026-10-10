import { callOp, interactions } from "@bb/plugin/app";
import { threadView } from "@bb/plugin/app";
import { useOwned } from "@bb/app-kit/plugins/slots";
import { useState } from "react";
import type { JsonValue, PendingInteraction } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  PendingInteractionShell,
  type PendingInteractionSourceThread,
} from "../thread/pending-interactions/PendingInteractionShell";
import { useStopThread } from "@bb/app-kit/hooks/mutations/thread-runtime-mutations";
import { usePluginDisplayName } from "@bb/app-kit/lib/plugin-logos";
import { PluginSlotMount } from "@bb/app-kit/plugins/mount";
import { usePluginsSettled } from "@bb/app-kit/plugins/registry";

export interface PluginPendingInteractionRequest {
  pluginId: string;
  rendererId: string;
  title: string;
  data: JsonValue;
}

export function PluginPendingInteractionComposer({
  interaction,
  request,
  origin,
  sourceThread,
}: {
  interaction: Pick<
    PendingInteraction,
    "id" | "threadId" | "createdAt" | "expiresAt"
  >;
  request: PluginPendingInteractionRequest;
  origin: "plugin" | "provider";
  sourceThread?: PendingInteractionSourceThread;
}) {
  const slot = useOwned(threadView.interaction).find(
    (candidate) =>
      candidate.pluginId === request.pluginId &&
      candidate.id === request.rendererId,
  );
  const pluginName = usePluginDisplayName(request.pluginId);
  const pluginsSettled = usePluginsSettled();
  const stopThread = useStopThread();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { id: interactionId, threadId } = interaction;
  const run = async (action: () => Promise<unknown>) => {
    setSubmitting(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSubmitting(false);
    }
  };
  const cancel = () =>
    run(() =>
      origin === "provider"
        ? stopThread.mutateAsync(threadId)
        : callOp(interactions.cancel, { interactionId, threadId }),
    );
  const dismiss = (problem: string) => (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The plugin form {problem}.{" "}
        {origin === "plugin" ? "Cancel" : "Stop turn"} to continue.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => void cancel()}
        disabled={submitting}
      >
        {origin === "plugin" ? "Cancel" : "Stop turn"}
      </Button>
    </div>
  );
  return (
    <PendingInteractionShell
      key={interactionId}
      label={request.title}
      initiallyExpanded
      errorMessage={error}
      sourceThread={sourceThread}
      testId="plugin-interaction-shell"
    >
      {() => (
        <>
          <p className="mb-4 text-xs text-muted-foreground">
            {origin === "plugin"
              ? `Requested by ${pluginName}`
              : `Asked by the agent through ${pluginName}`}
          </p>
          {slot ? (
            <PluginSlotMount
              pluginId={slot.pluginId}
              slotKind="pendingInteraction"
              slotId={slot.id}
              crashFallback={dismiss("crashed")}
            >
              <fieldset disabled={submitting}>
                <slot.view
                  interaction={{
                    id: interactionId,
                    threadId,
                    title: request.title,
                    payload: request.data,
                    createdAt: interaction.createdAt,
                    expiresAt: interaction.expiresAt ?? null,
                  }}
                  submit={(value) =>
                    run(() =>
                      callOp(interactions.respond, {
                        interactionId,
                        threadId,
                        value,
                      }),
                    )
                  }
                  cancel={cancel}
                />
              </fieldset>
            </PluginSlotMount>
          ) : pluginsSettled ? (
            dismiss("is unavailable")
          ) : (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label={`Loading the ${pluginName} form`}
              data-testid="plugin-interaction-loading"
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
        </>
      )}
    </PendingInteractionShell>
  );
}
