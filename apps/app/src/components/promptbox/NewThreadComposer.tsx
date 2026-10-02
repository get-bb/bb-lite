import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAtom } from "jotai";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type Host,
  type JsonValue,
} from "@bb/domain";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  ProjectSelector,
  type ProjectSelectorCreateProjectConfig,
} from "@/components/pickers/ProjectSelector";
import {
  encodeReuseValue,
  encodeProviderValue,
  parseEnvironmentValue,
  REUSE_VALUE_WITHOUT_ENVIRONMENT,
} from "@/components/pickers/environment-picker-value";
import {
  CheckoutInputs,
  WorktreeInputs,
  type EnvironmentInputsChange,
} from "@/components/pickers/EnvironmentInputs";
import { EnvironmentPicker } from "@/components/pickers/EnvironmentPicker";
import { formatModelLoadErrorText } from "@/components/pickers/model-load-error-message";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { ReuseEnvironmentPicker } from "@/components/pickers/ReuseEnvironmentPicker";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ModelReasoningPicker } from "@/components/pickers/ModelReasoningPicker";
import {
  PromptBoxInternal,
  type PromptBoxHandle,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptModePermissionDisplay } from "@/components/promptbox/usePromptModePermissionDisplay";
import {
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  getProjectStoredPromptAttachmentPaths,
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  promptDraftToInput,
  type AppCreateThreadRequest,
} from "@bb/client-core";
import { useDraftAttachmentUploads } from "@/components/promptbox/useDraftAttachmentUploads";
import { usePromptTypeahead } from "@/components/promptbox/usePromptTypeahead";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import {
  selectHosts,
  selectPrimaryHost,
  useHosts,
} from "@/hooks/queries/host-queries";
import { useProjectDefaultExecutionOptions } from "@/hooks/queries/project-default-execution-options-query";
import {
  stripProjectThreads,
  useProjectPromptHistory,
} from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useLocalHostId } from "@/hooks/useOpenTargets";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import {
  storedEnvironmentAtomFamily,
  storedMachineAtomFamily,
} from "@/hooks/thread-creation-options/persisted-selection-fields";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { useRootComposeReuseEnvironment } from "@/lib/root-compose-selection";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  buildReuseThreadOptions,
  resolveEffectiveEnvironmentValue,
} from "./new-thread-environment";

function sanitizeStoredEnvironmentValue(stored: string): string {
  return parseEnvironmentValue(stored)?.type === "provider" ? stored : "";
}

export function useNewThreadComposer({
  projectId: requestedProjectId,
  onProjectChange,
  onSubmit,
}: {
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  onSubmit: (request: AppCreateThreadRequest) => Promise<void>;
}) {
  const navigate = useNavigate();
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const focusPromptBox = () => promptBoxRef.current?.focusEnd();
  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;
  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", () => {
    if (!isFocusedPane || !promptBoxRef.current) return false;
    promptBoxRef.current.focusEnd();
    return true;
  });

  const navigationQuery = useSidebarNavigation();
  const navigation = navigationQuery.data;
  const projects = navigation?.projects.map(stripProjectThreads);
  const requestedCandidate = requestedProjectId ?? PERSONAL_PROJECT_ID;
  const candidateKnown =
    isProjectlessProjectId(requestedCandidate) ||
    (projects?.some((project) => project.id === requestedCandidate) ?? false);
  const replayKnowsCandidate =
    !navigationQuery.isPlaceholderData || candidateKnown;
  const navigationSettled =
    navigationQuery.isError ||
    (navigationQuery.isSuccess && replayKnowsCandidate);
  const projectId =
    isProjectlessProjectId(requestedCandidate) ||
    (projects && replayKnowsCandidate && !candidateKnown)
      ? PERSONAL_PROJECT_ID
      : requestedCandidate;
  const isProjectless = isProjectlessProjectId(projectId);
  const projectWithThreads = isProjectless
    ? navigation?.personalProject
    : navigation?.projects.find((project) => project.id === projectId);
  const currentProject = projectWithThreads
    ? stripProjectThreads(projectWithThreads)
    : undefined;
  const projectSources = currentProject?.sources ?? [];

  const hostsQuery = useHosts();
  const hosts = selectHosts(hostsQuery.data, "persistent");
  const systemConfigQuery = useSystemConfig();
  const configuredPrimaryHostId = systemConfigQuery.data?.primaryHostId ?? null;
  const localHostId = useLocalHostId();
  const primaryHostId =
    selectPrimaryHost(hosts, configuredPrimaryHostId)?.id ?? null;
  const knownHostIds = new Set(hosts.map((host) => host.id));
  const reuseThreadOptions = buildReuseThreadOptions(
    projectWithThreads?.threads ?? [],
    hosts.length <= 1
      ? null
      : new Map(hosts.map((host) => [host.id, host.name])),
  );

  const { providers: registeredProviders } = useSystemEnvironmentProviders();
  const { providers: projectProviders } = useSystemEnvironmentProviders({
    projectId,
  });
  const environmentProviders = registeredProviders?.filter(
    (provider) => provider.requires.projectless === isProjectless,
  );
  const providersByHostId = new Map(
    hosts.map((host) => [
      host.id,
      (environmentProviders ?? [])
        .filter(
          (provider) =>
            (!(
              provider.requires.projectCheckout || provider.requires.gitCheckout
            ) ||
              findLocalPathProjectSourceForHost(projectSources, host.id) !==
                undefined) &&
            (!provider.requires.gitRemote ||
              currentProject?.gitRemoteUrl != null),
        )
        .map((provider) => ({
          ...provider,
          availability:
            projectProviders?.find((candidate) => candidate.id === provider.id)
              ?.machineAvailability[host.id] ?? null,
        })),
    ]),
  );
  const usableProviders = (hostId: string | null) =>
    (hostId === null ? undefined : providersByHostId.get(hostId))?.filter(
      (provider) => provider.availability?.status !== "unavailable",
    ) ?? [];

  const [reuseValue, setReuseValue] = useRootComposeReuseEnvironment();
  const [storedEnvironment, setStoredEnvironment] = useAtom(
    storedEnvironmentAtomFamily(projectId),
  );
  const [storedMachineId, setStoredMachineId] = useAtom(
    storedMachineAtomFamily(projectId),
  );
  const environmentValue = resolveEffectiveEnvironmentValue({
    value: reuseValue ?? sanitizeStoredEnvironmentValue(storedEnvironment),
    providers: environmentProviders,
    isProjectless,
    knownHostIds,
    primaryHostId,
    projectSources,
    reuseThreadOptions,
    reuseThreadOptionsLoading:
      projectWithThreads === undefined && !navigationSettled,
  });
  const parsedEnvironment = parseEnvironmentValue(environmentValue);
  const environmentProvider =
    parsedEnvironment?.type === "provider"
      ? environmentProviders?.find(
          (provider) => provider.id === parsedEnvironment.environmentProviderId,
        )
      : undefined;
  const isUsableHost = (hostId: string | null | undefined) =>
    usableProviders(hostId ?? null).some(
      (provider) => provider.id === environmentProvider?.id,
    );
  const providerHostId =
    environmentProvider === undefined
      ? null
      : ([storedMachineId, primaryHostId].find(isUsableHost) ?? null);
  const reuseEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;
  const selectEnvironment = (value: string, hostId: string | null = null) => {
    if (parseEnvironmentValue(value)?.type === "reuse") {
      setReuseValue(value);
    } else {
      setReuseValue(null);
      setStoredEnvironment(value);
      setStoredMachineId(hostId ?? "");
    }
  };
  const selectHost = (hostId: string) => {
    const usable = usableProviders(hostId);
    const provider =
      usable.find((candidate) => candidate.id === environmentProvider?.id) ??
      usable[0];
    if (provider) selectEnvironment(encodeProviderValue(provider.id), hostId);
  };

  const inputsScopeKey = `${projectId}\0${environmentValue}\0${providerHostId ?? ""}`;
  const [inputsState, setInputsState] = useState<{
    scopeKey: string;
    value: JsonValue | undefined;
    blockedReason: string | null;
  } | null>(null);
  const activeInputs =
    inputsState?.scopeKey === inputsScopeKey ? inputsState : null;
  const InputsControl =
    environmentProvider === undefined || environmentProvider.inputs === null
      ? undefined
      : environmentProvider.id === GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID
        ? WorktreeInputs
        : environmentProvider.id === PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID
          ? CheckoutInputs
          : undefined;
  const providerInputs: JsonValue | null =
    InputsControl === undefined
      ? null
      : activeInputs?.value !== undefined
        ? activeInputs.value
        : null;
  const inputsBlocker =
    environmentProvider === undefined || InputsControl === undefined
      ? null
      : (activeInputs?.blockedReason ??
        (providerInputs === null
          ? `Configure ${environmentProvider.displayName}`
          : null));
  const changeInputs = (change: EnvironmentInputsChange) => {
    const next = {
      scopeKey: inputsScopeKey,
      value: change.status === "ready" ? change.value : activeInputs?.value,
      blockedReason: change.status === "blocked" ? change.reason : null,
    };
    if (JSON.stringify(next) !== JSON.stringify(activeInputs)) {
      setInputsState(next);
    }
  };
  const submissionEnvironment: AppCreateThreadRequest["environment"] | null =
    parsedEnvironment === null
      ? null
      : parsedEnvironment.type === "reuse"
        ? parsedEnvironment.environmentId === null
          ? null
          : { type: "reuse", environmentId: parsedEnvironment.environmentId }
        : environmentProvider === undefined ||
            providerHostId === null ||
            !isUsableHost(providerHostId) ||
            (environmentProvider.inputs !== null && providerInputs === null)
          ? null
          : {
              type: "provider",
              environmentProviderId: environmentProvider.id,
              machine: { type: "existing", hostId: providerHostId },
              inputs: providerInputs,
            };

  const projectDefaultsQuery = useProjectDefaultExecutionOptions(
    { projectId },
    {
      enabled:
        currentProject !== undefined &&
        currentProject.defaultExecutionOptions === null,
    },
  );
  const cachedDefaults = currentProject?.defaultExecutionOptions;
  const projectDefaultsStatus =
    cachedDefaults != null ||
    (currentProject !== undefined &&
      projectDefaultsQuery.isSuccess &&
      !projectDefaultsQuery.isPlaceholderData)
      ? "resolved"
      : currentProject !== undefined && projectDefaultsQuery.isError
        ? "error"
        : "pending";
  const projectDefaults =
    projectDefaultsStatus === "resolved"
      ? (cachedDefaults ?? projectDefaultsQuery.data ?? null)
      : undefined;
  const {
    execution,
    permission,
    activeModel,
    executionInputSources,
    isLoadingModels,
    modelLoadError,
    reasoningLevel,
    selectedModel,
    selectedProviderComposerActions,
    selectedProviderDisplayName,
    selectedProviderId,
    serviceTier,
    supportsServiceTier,
  } = useThreadCreationOptions({
    routing:
      providerHostId !== null
        ? { hostId: providerHostId }
        : reuseEnvironmentId !== null
          ? { environmentId: reuseEnvironmentId }
          : {},
    initialProviderId: projectDefaults?.providerId,
    initialModel: projectDefaults?.model,
    initialServiceTier: projectDefaults?.serviceTier,
    initialReasoningLevel: projectDefaults?.reasoningLevel,
    initialPermissionMode: projectDefaults?.permissionMode,
  });
  const selectedThreadModel = activeModel?.model ?? selectedModel;

  const promptDraft = usePromptDraftStorage({ kind: "new-thread" });
  const currentDraft = {
    text: promptDraft.text,
    mentions: promptDraft.mentions,
    attachments: promptDraft.attachments,
  };
  const uploads = useDraftAttachmentUploads(projectId, {
    key: promptDraft.storageKey,
    addAttachment: promptDraft.addAttachment,
  });
  const [isCopyingAttachments, setIsCopyingAttachments] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isProjectChangeLocked =
    uploads.isAttachingFiles || isCopyingAttachments || isSubmitting;
  const changeProject = async (nextProjectId: string | null) => {
    const nextValue = nextProjectId ?? PERSONAL_PROJECT_ID;
    if (nextValue === projectId || isProjectChangeLocked) return;
    const paths = getProjectStoredPromptAttachmentPaths(
      promptDraft.getCurrent().attachments,
    );
    setIsCopyingAttachments(true);
    uploads.setAttachmentError(null);
    await (
      paths.length === 0
        ? Promise.resolve()
        : sdk.projects.attachments.copy({
            projectId: nextValue,
            sourceProjectId: projectId,
            paths,
          })
    )
      .then(() => onProjectChange(nextValue))
      .catch((error: unknown) =>
        uploads.setAttachmentError(
          getMutationErrorMessage({
            error,
            fallbackMessage:
              "Attachments could not be moved to the selected project",
          }),
        ),
      );
    setIsCopyingAttachments(false);
  };

  const mentionHostId =
    reuseEnvironmentId !== null ? null : (providerHostId ?? primaryHostId);
  const { typeahead, promptActions } = usePromptTypeahead({
    projectId,
    mentionsProjectId: isProjectless ? undefined : projectId,
    providerId: selectedProviderId,
    commandScope: "new-thread",
    environmentId: reuseEnvironmentId,
    hostId: mentionHostId,
    composerActions: selectedProviderComposerActions,
    resolveMentionLink: (resource) =>
      resource.kind === "thread"
        ? () =>
            navigate(
              getThreadRoutePath({
                projectId: resource.projectId ?? projectId,
                threadId: resource.threadId,
              }),
            )
        : resource.kind === "project"
          ? () => navigate(getProjectComposeRoutePath(resource.projectId))
          : null,
  });
  const { data: promptHistory = [] } = useProjectPromptHistory(projectId, {
    enabled: navigationSettled,
  });

  const fatalModelLoadError =
    modelLoadError !== null &&
    (!selectedThreadModel ||
      modelLoadError.code === "provider_unavailable" ||
      modelLoadError.code === "missing_executable" ||
      modelLoadError.code === "auth_required")
      ? modelLoadError
      : null;
  const submitDisabledReason = isSubmitting
    ? "Starting thread..."
    : isCopyingAttachments
      ? "Moving attachments to the selected project..."
      : uploads.isAttachingFiles
        ? "Uploading attachments..."
        : projectDefaultsStatus !== "resolved"
          ? projectDefaultsStatus === "error"
            ? "Could not load the project's execution defaults."
            : "Loading the project's execution defaults..."
          : !selectedProviderId
            ? "Select a provider."
            : isLoadingModels
              ? "Loading models from the selected machine..."
              : fatalModelLoadError
                ? formatModelLoadErrorText({
                    error: fatalModelLoadError,
                    providerLabel:
                      selectedProviderDisplayName || selectedProviderId,
                  })
                : !selectedThreadModel
                  ? "Select a model."
                  : (inputsBlocker ??
                    (submissionEnvironment === null
                      ? "Select an environment."
                      : promptDraftToInput(currentDraft).length === 0
                        ? "Enter a prompt or attach a file."
                        : null));
  const submitDraft = async () => {
    const submittedDraft = promptDraft.getCurrent();
    const input = promptDraftToInput(submittedDraft);
    if (
      submitDisabledReason !== null ||
      submissionEnvironment === null ||
      input.length === 0
    ) {
      return;
    }
    setIsSubmitting(true);
    uploads.setAttachmentError(null);
    const cleared = promptDraft.clearIfCurrentMatches(submittedDraft);
    await Promise.resolve(
      onSubmit({
        projectId,
        providerId: selectedProviderId,
        model: selectedThreadModel,
        reasoningLevel,
        permissionMode: permission.value,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        executionInputSources,
        environment: submissionEnvironment,
        input,
      }),
    )
      .then(() => setReuseValue(null))
      .catch(() => {
        if (cleared) promptDraft.restoreIfEmpty(submittedDraft);
      });
    setIsSubmitting(false);
  };

  const { permissionDisplayOverride, permissionPickerDisabledByPlanMode } =
    usePromptModePermissionDisplay({
      execution,
      value: promptDraft.text,
      mentionRanges: promptDraft.mentions,
      activePromptMode: null,
    });
  const [environmentPickerOpen, setEnvironmentPickerOpen] = useState(false);
  const environmentLoading = environmentProviders === undefined;
  const renderEnvironmentControls = (
    onRequestMachineSetup: ((host: Host) => void) | undefined,
  ) =>
    !isProjectless ||
    environmentLoading ||
    (environmentProviders?.length ?? 0) > 1 ||
    parsedEnvironment?.type === "reuse" ||
    environmentPickerOpen ||
    hosts.length > 1 ? (
      <>
        <EnvironmentPicker
          value={environmentValue}
          open={environmentPickerOpen}
          onOpenChange={setEnvironmentPickerOpen}
          sources={projectSources}
          hosts={hosts}
          localHostId={localHostId}
          primaryHostId={configuredPrimaryHostId}
          isLoading={environmentLoading}
          onRequestMachineSetup={
            isProjectless ? undefined : onRequestMachineSetup
          }
          providers={environmentProviders ?? []}
          providersByHostId={providersByHostId}
          selectedProviderHostId={providerHostId}
          onSelectProvider={(provider: SystemEnvironmentProvider, hostId) =>
            selectEnvironment(encodeProviderValue(provider.id), hostId)
          }
          onSelectHost={selectHost}
          onSelectReuse={() =>
            selectEnvironment(REUSE_VALUE_WITHOUT_ENVIRONMENT)
          }
        />
        {parsedEnvironment?.type === "reuse" ? (
          <ReuseEnvironmentPicker
            options={reuseThreadOptions}
            value={reuseEnvironmentId}
            onChange={(environmentId) =>
              selectEnvironment(encodeReuseValue(environmentId))
            }
          />
        ) : null}
        {InputsControl ? (
          <InputsControl
            projectId={isProjectless ? null : projectId}
            hostId={providerHostId}
            value={providerInputs}
            onChange={changeInputs}
          />
        ) : null}
      </>
    ) : null;

  const renderPromptBox = (options: {
    createProject: ProjectSelectorCreateProjectConfig;
    onRequestMachineSetup: (host: Host) => void;
  }) => (
    <div
      data-app-composer=""
      data-app-composer-role="primary"
      data-promptbox-shell=""
      className="w-full"
    >
      <PromptBoxInternal
        id="root-compose-prompt"
        promptBoxRef={promptBoxRef}
        value={promptDraft.text}
        mentionRanges={promptDraft.mentions}
        onChange={promptDraft.setTextAndMentions}
        onSubmit={() => void submitDraft()}
        history={{
          currentDraft,
          entries: promptHistoryEntriesToDrafts(promptHistory),
          onSelectEntry: promptDraft.setDraft,
          resetKey: projectId,
        }}
        typeahead={typeahead}
        mentionMenuPlacement="bottom"
        attachments={{
          items: promptDraft.attachments,
          pendingUploads: uploads.pendingUploads,
          projectId,
          onAttachFiles: uploads.handleAttachFiles,
          onRemove: promptDraft.removeAttachment,
          isAttaching: uploads.isAttachingFiles || isCopyingAttachments,
          error: uploads.attachmentError,
        }}
        promptActions={promptActions}
        submission={{
          isSubmitting,
          disabled: submitDisabledReason !== null,
          disabledReason: submitDisabledReason ?? undefined,
          title: isSubmitting
            ? "Submitting..."
            : isLoadingModels
              ? "Loading models..."
              : "Submit (Enter)",
        }}
        autoFocus
        editorLayout="root-compose"
        minHeight={80}
        placeholder={
          isProjectless
            ? "Ask anything."
            : "Ask anything. @ to mention files, folders, or sections"
        }
        footerStart={<ModelReasoningPicker {...execution} muted />}
      />
      <div className="mt-1 flex select-none items-center justify-between gap-2 px-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <ProjectSelector
            projects={projects ?? []}
            value={isProjectless ? null : projectId}
            onChange={(nextProjectId) => void changeProject(nextProjectId)}
            createProject={options.createProject}
            disabled={isProjectChangeLocked}
            isLoading={!navigationSettled}
          />
          {renderEnvironmentControls(options.onRequestMachineSetup)}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PermissionModePicker
            {...permission}
            disabled={permissionPickerDisabledByPlanMode}
            showChevronWhenDisabled={permissionPickerDisabledByPlanMode}
            displayOverride={permissionDisplayOverride}
          />
        </div>
      </div>
    </div>
  );

  return {
    projectId,
    projects,
    sidebarNavigationError: navigationQuery.isError,
    currentProject,
    environmentProviderId: environmentProvider?.id ?? null,
    promptDraft,
    focusPromptBox,
    selectEnvironment,
    renderPromptBox,
  };
}
