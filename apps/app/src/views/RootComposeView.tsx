import {
  readThreadCreationPlacement,
  DEFAULT_THREAD_CREATION_PLACEMENT,
  useRootComposePlacement,
  useRootComposeProjectId,
  useSetRootComposeProjectId,
} from "@/lib/root-compose-selection";
import { useInitialPromptDraft } from "@/components/promptbox/mentions/initial-prompt-draft";
import { useEffect, useEffectEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useNewThreadComposer } from "@/components/promptbox/NewThreadComposer";
import {
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  type PromptDraftState,
} from "@bb/client-core";
import {
  encodeProviderValue,
  encodeReuseValue,
} from "@/components/pickers/environment-picker-value";
import {
  ProjectMachineSetupDialog,
  type ProjectMachineSetupDialogTarget,
} from "@/components/dialogs/ProjectMachineSetupDialog";
import { PANEL_COLLAPSE_TRANSITION_CLASS } from "@/components/secondary-panel/panelTransitionTokens";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { PageShell } from "@/components/ui/page-shell.js";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style.js";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@bb/shared-ui/lib/utils";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { RootComposeCompactHome } from "./RootComposeCompactHome";
import { RootComposeEmptyWelcome } from "./RootComposeEmptyWelcome";
import { RootComposeMobileRecents } from "./RootComposeMobileRecents";
import { usePaneContext } from "./thread-detail/PaneContext";

const INITIAL_PROMPT_SEARCH_PARAM = "initialPrompt";
const INITIAL_PROMPT_MAX_LENGTH = 8000;

function readStateString(state: unknown, key: string): string | null {
  const value =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)[key]
      : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasFocusPromptState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "focusPrompt" in state &&
    state.focusPrompt === true
  );
}

export function LegacyProjectComposeRedirect({
  projectId,
}: {
  projectId: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const [, setPlacement] = useRootComposePlacement();

  useEffect(() => {
    setRootComposeProjectId(projectId);
    setPlacement(DEFAULT_THREAD_CREATION_PLACEMENT);
    navigate(getRootComposeRoutePath(), {
      replace: true,
      state: location.state,
    });
  }, [
    location.state,
    navigate,
    projectId,
    setRootComposeProjectId,
    setPlacement,
  ]);

  return <RouteLoadingSkeleton isBoundedPane={false} />;
}

export function RootComposeView() {
  const paneContext = usePaneContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [rootComposeProjectId, setRootComposeProjectId] =
    useRootComposeProjectId();
  const createThread = useCreateThread();
  const [placement, setPlacement] = useRootComposePlacement();
  const [navigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();
  const quickCreateProject = useQuickCreateProjectController();
  const isPointerCoarse = usePointerCoarse();
  const isCompactViewport = useIsCompactViewport();
  const [lastCreatedThreadId, setLastCreatedThreadId] = useState<string | null>(
    null,
  );
  const {
    projectId,
    projects,
    currentProject,
    promptDraft,
    focusPromptBox,
    isSubmitting,
    selectEnvironment,
    environmentProviderId,
    sidebarNavigationError,
    renderPromptBox,
  } = useNewThreadComposer({
    projectId: rootComposeProjectId,
    onProjectChange: setRootComposeProjectId,
    onSubmit: async (request) => {
      const thread = await createThread.mutateAsync({
        ...request,
        ...placement,
      });
      setLastCreatedThreadId(thread.id);
      setPlacement(DEFAULT_THREAD_CREATION_PLACEMENT);
      if (navigateToThreadAfterCreate) {
        paneContext.navigateInPane({
          projectId: thread.projectId,
          threadId: thread.id,
        });
      }
    },
  });
  const [startedComposing, setStartedComposing] = useState(() =>
    hasFocusPromptState(location.state),
  );
  const [machineSetupTarget, setMachineSetupTarget] =
    useState<ProjectMachineSetupDialogTarget | null>(null);
  const showEmptyWelcome =
    !startedComposing && projects !== undefined && projects.length === 0;
  const focusSoon = useEffectEvent(() => {
    if (!isPointerCoarse) window.requestAnimationFrame(focusPromptBox);
  });

  useEffect(() => {
    if (projectId !== rootComposeProjectId) setRootComposeProjectId(projectId);
  }, [projectId, rootComposeProjectId, setRootComposeProjectId]);
  useAppCommandHandler("composer.focus", () => {
    if (!paneContext.isFocused || !showEmptyWelcome) return false;
    setStartedComposing(true);
    return true;
  });
  useEffect(() => {
    if (startedComposing) focusSoon();
  }, [startedComposing]);

  const searchParams = new URLSearchParams(location.search);
  const searchPrompt =
    searchParams.get(INITIAL_PROMPT_SEARCH_PARAM)?.trim() || null;
  const statePrompt = readStateString(location.state, "initialPrompt");
  const searchDraft = useInitialPromptDraft(
    searchPrompt?.slice(0, INITIAL_PROMPT_MAX_LENGTH) ?? null,
  );
  const stateDraft = useInitialPromptDraft(statePrompt);
  const applySearchDraft = useEffectEvent((draft: PromptDraftState) => {
    setStartedComposing(true);
    promptDraft.setDraft(draft);
    searchParams.delete(INITIAL_PROMPT_SEARCH_PARAM);
    const rest = searchParams.toString();
    navigate(getRootComposeRoutePath() + (rest ? `?${rest}` : ""), {
      replace: true,
      state: location.state,
    });
  });
  useEffect(() => {
    if (searchPrompt !== null && searchDraft !== undefined) {
      applySearchDraft(searchDraft);
    }
  }, [searchPrompt, searchDraft]);
  const applyLocationState = useEffectEvent(
    (state: unknown, draft: PromptDraftState | undefined) => {
      const targetPlacement = readThreadCreationPlacement(state);
      const reuseEnvironmentId = readStateString(state, "reuseEnvironmentId");
      const focusPrompt = hasFocusPromptState(state) || statePrompt !== null;
      if (
        (statePrompt !== null && draft === undefined) ||
        (targetPlacement === null &&
          reuseEnvironmentId === null &&
          !focusPrompt)
      ) {
        return;
      }
      if (draft !== undefined) promptDraft.restoreIfEmpty(draft);
      setPlacement(targetPlacement ?? DEFAULT_THREAD_CREATION_PLACEMENT);
      if (reuseEnvironmentId !== null) {
        selectEnvironment(encodeReuseValue(reuseEnvironmentId));
      }
      if (focusPrompt) {
        setStartedComposing(true);
        focusSoon();
      }
      navigate(getRootComposeRoutePath() + location.search, {
        replace: true,
        state: null,
      });
    },
  );
  useEffect(() => {
    applyLocationState(location.state, stateDraft);
  }, [location.state, stateDraft]);

  if (!projects && sidebarNavigationError) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          Failed to load projects.
        </p>
      </PageShell>
    );
  }

  const createProject = {
    onCreate: quickCreateProject.openCreateDialog,
    disabled: !quickCreateProject.isAvailable || quickCreateProject.isCreating,
    isCreating: quickCreateProject.isCreating,
  };
  const isHosted = paneContext.secondaryPanelHost !== null;
  const isCompactHomeLayout = isCompactViewport && !showEmptyWelcome;
  const promptBox = showEmptyWelcome
    ? null
    : renderPromptBox({
        mentionMenuPlacement: isCompactHomeLayout ? "top" : "bottom",
        createProject,
        onRequestMachineSetup: (host) => {
          if (!currentProject) return;
          setMachineSetupTarget({
            projectId,
            projectName: currentProject.name,
            gitRemoteUrl: currentProject.gitRemoteUrl ?? null,
            hostId: host.id,
            hostName: host.name,
          });
        },
      });

  return (
    <>
      <ProjectMachineSetupDialog
        target={machineSetupTarget}
        onOpenChange={(open) => {
          if (!open) setMachineSetupTarget(null);
        }}
        onComplete={({ hostId }) => {
          setMachineSetupTarget(null);
          selectEnvironment(
            encodeProviderValue(
              environmentProviderId ?? PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
            ),
            hostId,
          );
        }}
      />
      <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip md:-mx-5 md:-mb-5 md:-mt-5">
        <div
          data-split-pane-id={isHosted ? undefined : paneContext.paneId}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col transition-opacity",
            !isHosted && "h-full",
            PANEL_COLLAPSE_TRANSITION_CLASS,
          )}
        >
          <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {isCompactHomeLayout ? (
              <div
                className="@container/page flex min-h-0 flex-1 flex-col"
                style={PAGE_SHELL_CONTENT_STYLE}
              >
                <RootComposeCompactHome composer={promptBox}>
                  <RootComposeMobileRecents
                    highlightedThreadId={lastCreatedThreadId}
                    showCreatingRow={isSubmitting}
                  />
                </RootComposeCompactHome>
              </div>
            ) : (
              <div className="@container/page min-h-0 flex-1 overflow-y-auto">
                <div
                  className={cn(
                    "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
                    "max-w-[760px]",
                    showEmptyWelcome
                      ? "min-h-full flex-1 items-center justify-center pb-12"
                      : "pt-14",
                  )}
                  style={PAGE_SHELL_CONTENT_STYLE}
                >
                  {showEmptyWelcome ? (
                    <RootComposeEmptyWelcome
                      onCompose={(prefill) => {
                        if (prefill)
                          promptDraft.setTextAndMentions(prefill, []);
                        setStartedComposing(true);
                      }}
                      onAddProject={createProject.onCreate}
                      addProjectDisabled={createProject.disabled}
                    />
                  ) : (
                    promptBox
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
