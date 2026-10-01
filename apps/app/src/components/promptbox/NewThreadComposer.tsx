import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import { usePendingAttachmentUploads } from "./usePendingAttachmentUploads";
import { useInitialPromptDraft } from "./mentions/initial-prompt-draft";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type EnvironmentMachineSelection,
  type Host,
  type JsonValue,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type { NewThreadRequest } from "@bb/plugin/app";
import type {
  CreateExecutionInputSources,
  SidebarBootstrapResponse,
  SystemEnvironmentProvider,
  SystemExecutionOptionsModelLoadError,
} from "@bb/server-contract";
import type { ProjectSelectorCreateProjectConfig } from "@/components/pickers/ProjectSelector";
import {
  encodeReuseValue,
  encodeProviderValue,
  parseEnvironmentValue,
  REUSE_VALUE_WITHOUT_ENVIRONMENT,
} from "@/components/pickers/environment-picker-value";
import { CheckoutInputs } from "@/components/pickers/environment-inputs/CheckoutInputs";
import type {
  EnvironmentInputsChange,
  EnvironmentInputsProps,
} from "@/components/pickers/environment-inputs/environment-inputs";
import { WorktreeInputs } from "@/components/pickers/environment-inputs/WorktreeInputs";
import { formatModelLoadErrorText } from "@/components/pickers/model-load-error-message";
import {
  NewThreadPromptBox,
  type NewThreadPromptBoxProps,
} from "@/components/promptbox/NewThreadPromptBox";
import {
  buildProviderPromptActionProps,
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
} from "@bb/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { newThreadEnvironmentArgsToSeed } from "@/components/plugin/new-thread-environment-seed";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
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
  type SidebarProject,
} from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import {
  usePromptDraftStorage,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { usePromptBoxMachinePreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import {
  arePromptDraftStatesEqual,
  getProjectStoredPromptAttachmentPaths,
  isPromptDraftEmpty,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@bb/client-core";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import {
  buildReuseThreadOptions,
  resolveHostEnvironmentProvider,
  resolveNewThreadHostEnvironmentProvider,
  resolveRootComposeEffectiveEnvironmentValue,
  type SeededReuseEnvironment,
} from "@/views/root-compose-environment-selection";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { resolveRootComposeThreadEnvironment } from "@/views/root-compose-thread-environment";

const ENVIRONMENT_INPUTS_CONTROLS = new Map<
  string,
  ComponentType<EnvironmentInputsProps>
>([
  [GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID, WorktreeInputs],
  [PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID, CheckoutInputs],
]);

type NewThreadComposerSelectionScope = "new-thread" | "component-local";

export interface NewThreadComposerSeed {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
  environment?: NewThreadRequest["environment"];
  initialPrompt?: string;
}

interface NewThreadComposerLocks {
  project?: boolean;
  provider?: boolean;
  environment?: boolean;
}

interface NewThreadComposerPromptOptions {
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  header?: ReactNode;
  resolveMentionLink?: PromptMentionLinkResolver;
  pluginComposerHost?: PluginComposerHost;
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  onRequestMachineSetup?: (host: Host) => void;
  locks?: NewThreadComposerLocks;
  mentionMenuPlacement: NewThreadPromptBoxProps["mentionMenuPlacement"];
}

type PromptDraftController = ReturnType<typeof usePromptDraftStorage>;
type ParsedEnvironment = ReturnType<typeof parseEnvironmentValue>;

export interface NewThreadComposerState {
  projectId: string;
  isProjectless: boolean;
  projects: readonly SidebarProject[] | undefined;
  sidebarNavigation: SidebarBootstrapResponse | undefined;
  sidebarNavigationError: boolean;
  currentProject: SidebarProject | undefined;
  projectSources: SidebarProject["sources"];
  connectedHostIds: ReadonlySet<string>;
  primaryHostId: string | null;
  parsedEnvironment: ParsedEnvironment;
  projectHostId: string | null;
  panelThreadId: string | null;
  promptDraft: PromptDraftController;
  focusPromptBox: () => void;
  pluginComposerHost: PluginComposerHost;
  isSubmitting: boolean;
  seedEnvironmentSelectionValue: (value: string) => void;
  hostSelectionReady: boolean;
  selectHostForNewEnvironment: (hostId: string) => void;
  setEnvironmentSelectionValue: (
    value: string,
    providerHostId?: string | null,
  ) => void;
  setProviderModelReasoning: (selection: {
    providerId: string;
    model: string;
    reasoningLevel: ReasoningLevel;
  }) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setServiceTier: (value: ServiceTier | undefined) => void;
  renderPromptBox: (options: NewThreadComposerPromptOptions) => ReactNode;
}

export function resolveSubmittedExecutionSources(
  environment: NewThreadRequest["environment"],
  sources: CreateExecutionInputSources,
): CreateExecutionInputSources {
  return environment.type === "provider" &&
    environment.machine?.type !== "existing"
    ? { ...sources, model: "explicit" }
    : sources;
}

export type NewThreadComposerSubmission = NewThreadRequest;

export interface NewThreadComposerProps {
  projectId: string | null;
  onProjectChange: (projectId: string) => void | Promise<void>;
  draftStorage: PromptDraftScope;
  selectionScope: NewThreadComposerSelectionScope;
  seed?: NewThreadComposerSeed;
  resetKey?: string | number | null;
  preferReadyProviderWhenUnset?: boolean;
  onSubmit: (request: NewThreadComposerSubmission) => void | Promise<void>;
  focusRequest?: number;
  children: (state: NewThreadComposerState) => ReactNode;
}

function NewThreadComposerStateRenderer({
  render,
  state,
}: {
  render: NewThreadComposerProps["children"];
  state: NewThreadComposerState;
}) {
  return render(state);
}

type ProjectDefaultsState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "resolved"; defaults: ProjectExecutionDefaults | null };

export interface ResolveNewThreadSubmitDisabledReasonArgs {
  environmentProviderInputsBlocker: string | null;
  isCopyingAttachments: boolean;
  isLoadingModels: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  projectDefaultsStatus: ProjectDefaultsState["status"];
  projectDefaultsUnavailable: boolean;
  promptInputEmpty: boolean;
  providerDisplayName: string;
  selectedProviderId: string;
  selectedThreadModel: string;
  submissionEnvironmentUnavailable: boolean;
}

export function resolveNewThreadSubmitDisabledReason({
  environmentProviderInputsBlocker,
  isCopyingAttachments,
  isLoadingModels,
  isSubmitting,
  isUploading,
  modelLoadError,
  projectDefaultsStatus,
  projectDefaultsUnavailable,
  promptInputEmpty,
  providerDisplayName,
  selectedProviderId,
  selectedThreadModel,
  submissionEnvironmentUnavailable,
}: ResolveNewThreadSubmitDisabledReasonArgs): string | null {
  if (isSubmitting) return "Starting thread...";
  if (isCopyingAttachments) {
    return "Moving attachments to the selected project...";
  }
  if (isUploading) return "Uploading attachments...";
  if (projectDefaultsUnavailable) {
    return projectDefaultsStatus === "error"
      ? "Could not load the project's execution defaults."
      : "Loading the project's execution defaults...";
  }
  if (!selectedProviderId) return "Select a provider.";
  if (isLoadingModels) {
    return "Loading models from the selected machine...";
  }

  const fatalModelLoadError =
    modelLoadError?.code === "provider_unavailable" ||
    modelLoadError?.code === "missing_executable" ||
    modelLoadError?.code === "auth_required";
  if (modelLoadError && (fatalModelLoadError || !selectedThreadModel)) {
    return formatModelLoadErrorText({
      error: modelLoadError,
      providerLabel: providerDisplayName || selectedProviderId,
    });
  }
  if (!selectedThreadModel) return "Select a model.";
  if (environmentProviderInputsBlocker) return environmentProviderInputsBlocker;
  if (submissionEnvironmentUnavailable) return "Select an environment.";
  if (promptInputEmpty) return "Enter a prompt or attach a file.";
  return null;
}

export function resolveNewThreadProjectDefaultsState({
  cachedDefaults,
  projectFound,
  queryData,
  queryIsError,
  queryIsPlaceholderData,
  queryIsSuccess,
}: {
  cachedDefaults: ProjectExecutionDefaults | null | undefined;
  projectFound: boolean;
  queryData: ProjectExecutionDefaults | null | undefined;
  queryIsError: boolean;
  queryIsPlaceholderData: boolean;
  queryIsSuccess: boolean;
}): ProjectDefaultsState {
  if (cachedDefaults !== null && cachedDefaults !== undefined) {
    return { status: "resolved", defaults: cachedDefaults };
  }
  if (!projectFound) return { status: "pending" };
  if (queryIsSuccess && !queryIsPlaceholderData) {
    return { status: "resolved", defaults: queryData ?? null };
  }
  return queryIsError ? { status: "error" } : { status: "pending" };
}

function mergeMissingPromptDraftAttachments(
  currentAttachments: readonly PromptDraftAttachment[],
  preservedAttachments: readonly PromptDraftAttachment[],
): PromptDraftAttachment[] | null {
  const existingPaths = new Set(
    currentAttachments.map((attachment) => attachment.path),
  );
  const missingAttachments = preservedAttachments.filter(
    (attachment) => !existingPaths.has(attachment.path),
  );
  return missingAttachments.length === 0
    ? null
    : [...currentAttachments, ...missingAttachments];
}

export function restorePromptDraftAfterOptionChange({
  currentDraft,
  preservedDraft,
}: {
  currentDraft: PromptDraftState;
  preservedDraft: PromptDraftState | null;
}): PromptDraftState | null {
  if (
    preservedDraft === null ||
    arePromptDraftStatesEqual(currentDraft, preservedDraft)
  ) {
    return null;
  }

  let restoredDraft = currentDraft;
  let changed = false;
  if (isPromptDraftEmpty(currentDraft) && !isPromptDraftEmpty(preservedDraft)) {
    restoredDraft = preservedDraft;
    changed = true;
  } else if (
    currentDraft.text === preservedDraft.text &&
    currentDraft.mentions !== preservedDraft.mentions &&
    JSON.stringify(currentDraft.mentions) !==
      JSON.stringify(preservedDraft.mentions)
  ) {
    restoredDraft = { ...restoredDraft, mentions: preservedDraft.mentions };
    changed = true;
  }

  const mergedAttachments = mergeMissingPromptDraftAttachments(
    restoredDraft.attachments,
    preservedDraft.attachments,
  );
  if (mergedAttachments !== null) {
    restoredDraft = { ...restoredDraft, attachments: mergedAttachments };
    changed = true;
  }
  return changed ? restoredDraft : null;
}

function useDraftPreservingOptionChange<T>(
  current: T,
  setValue: (value: T) => void,
  snapshot: () => void,
): (value: T) => void {
  return useCallback(
    (value: T) => {
      if (Object.is(current, value)) return;
      snapshot();
      setValue(value);
    },
    [current, setValue, snapshot],
  );
}

function resolvePanelThreadId(
  environmentId: string | null,
  reuseThreadOptions: ReturnType<typeof buildReuseThreadOptions>,
): string | null {
  if (environmentId === null) return null;
  return (
    reuseThreadOptions.find((option) => option.environmentId === environmentId)
      ?.threads[0]?.id ?? null
  );
}

export function NewThreadComposer({
  projectId: requestedProjectId,
  onProjectChange,
  draftStorage,
  selectionScope,
  seed,
  resetKey,
  preferReadyProviderWhenUnset = false,
  onSubmit,
  focusRequest,
  children,
}: NewThreadComposerProps) {
  const navigate = useNavigate();
  const [localPromptBoxFocusRequest, setLocalPromptBoxFocusRequest] = useState<
    number | null
  >(null);
  const promptBoxFocusRequest =
    focusRequest === undefined && localPromptBoxFocusRequest === null
      ? undefined
      : `${focusRequest ?? ""}:${localPromptBoxFocusRequest ?? ""}`;

  const sidebarNavigationQuery = useSidebarNavigation();
  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );
  const requestedCandidate = requestedProjectId ?? PERSONAL_PROJECT_ID;
  const candidateKnown =
    isProjectlessProjectId(requestedCandidate) ||
    (projects?.some((project) => project.id === requestedCandidate) ?? false);
  const replayKnowsCandidate =
    !sidebarNavigationQuery.isPlaceholderData || candidateKnown;
  const sidebarNavigationSettled =
    sidebarNavigationQuery.isError ||
    (sidebarNavigationQuery.isSuccess && replayKnowsCandidate);
  const projectId = useMemo(() => {
    if (isProjectlessProjectId(requestedCandidate)) return PERSONAL_PROJECT_ID;
    if (!projects || !replayKnowsCandidate) return requestedCandidate;
    return candidateKnown ? requestedCandidate : PERSONAL_PROJECT_ID;
  }, [candidateKnown, projects, replayKnowsCandidate, requestedCandidate]);
  const isProjectless = isProjectlessProjectId(projectId);
  const currentProject = useMemo(() => {
    if (isProjectless) {
      const personalProject = sidebarNavigationQuery.data?.personalProject;
      return personalProject ? stripProjectThreads(personalProject) : undefined;
    }
    return projects?.find((project) => project.id === projectId);
  }, [isProjectless, projectId, projects, sidebarNavigationQuery.data]);
  const projectSources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources],
  );
  const projectOptions = useMemo(
    () => projects?.map(({ id, name }) => ({ id, name })) ?? [],
    [projects],
  );

  const hostsQuery = useHosts();
  const availableHosts = useMemo(
    () => selectHosts(hostsQuery.data, "persistent"),
    [hostsQuery.data],
  );
  const systemConfigQuery = useSystemConfig();
  const primaryHostId =
    selectPrimaryHost(
      availableHosts,
      systemConfigQuery.data?.primaryHostId ?? null,
    )?.id ?? null;
  const knownHostIds = useMemo(
    () => new Set(availableHosts.map((host) => host.id)),
    [availableHosts],
  );
  const connectedHostIds = useMemo(
    () =>
      new Set(
        availableHosts
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [availableHosts],
  );
  const worktreeHostNameById = useMemo(() => {
    const hosts = availableHosts;
    return hosts.length <= 1
      ? null
      : new Map(hosts.map((host) => [host.id, host.name]));
  }, [availableHosts]);
  const projectThreads = useMemo(() => {
    const navigation = sidebarNavigationQuery.data;
    if (!navigation) return undefined;
    if (isProjectless) return navigation.personalProject.threads;
    return navigation.projects.find((project) => project.id === projectId)
      ?.threads;
  }, [isProjectless, projectId, sidebarNavigationQuery.data]);
  const reuseThreadOptionsLoading =
    projectThreads === undefined && !sidebarNavigationSettled;
  const threadDerivedReuseOptions = useMemo(
    () => buildReuseThreadOptions(projectThreads ?? [], worktreeHostNameById),
    [projectThreads, worktreeHostNameById],
  );

  const { providers: registeredEnvironmentProviders } =
    useSystemEnvironmentProviders();
  const environmentProviders = useMemo(
    () =>
      registeredEnvironmentProviders?.filter((provider) =>
        isProjectless
          ? !provider.requires.projectCheckout && !provider.requires.gitRemote
          : !provider.requires.projectless,
      ),
    [isProjectless, registeredEnvironmentProviders],
  );
  const { providers: projectEnvironmentProviders } =
    useSystemEnvironmentProviders({ projectId });
  const projectGitRemoteUrl = currentProject?.gitRemoteUrl;
  const environmentProvidersByHostId = useMemo(
    () =>
      new Map(
        availableHosts.map((host) => [
          host.id,
          (environmentProviders ?? [])
            .filter(
              (provider) =>
                (!(
                  provider.requires.projectCheckout ||
                  provider.requires.gitCheckout
                ) ||
                  findLocalPathProjectSourceForHost(projectSources, host.id) !==
                    undefined) &&
                (!provider.requires.gitRemote || projectGitRemoteUrl != null),
            )
            .map((provider) => ({
              ...provider,
              availability:
                projectEnvironmentProviders?.find(
                  (candidate) => candidate.id === provider.id,
                )?.machineAvailability[host.id] ?? null,
            })),
        ]),
      ),
    [
      availableHosts,
      environmentProviders,
      projectEnvironmentProviders,
      projectGitRemoteUrl,
      projectSources,
    ],
  );

  const seedSignature = JSON.stringify([
    projectId,
    resetKey ?? null,
    seed?.providerId ?? null,
    seed?.model ?? null,
    seed?.reasoningLevel ?? null,
    seed?.serviceTier ?? null,
    seed?.permissionMode ?? null,
    seed?.environment ?? null,
  ]);
  const environmentSeed = useMemo(
    () =>
      seed?.environment === undefined
        ? null
        : newThreadEnvironmentArgsToSeed(seed.environment),
    [seed?.environment],
  );
  const seededReuseEnvironmentId = useMemo(() => {
    if (environmentSeed === null) return null;
    const parsed = parseEnvironmentValue(environmentSeed.selectionValue);
    return parsed?.type === "reuse" ? parsed.environmentId : null;
  }, [environmentSeed]);
  const seededReuseIsThreadDerived =
    seededReuseEnvironmentId !== null &&
    threadDerivedReuseOptions.some(
      (option) => option.environmentId === seededReuseEnvironmentId,
    );
  const seededReuseLookupId =
    seededReuseEnvironmentId !== null && !seededReuseIsThreadDerived
      ? seededReuseEnvironmentId
      : null;
  const seededReuseEnvironmentQuery = useEnvironment(seededReuseLookupId);
  const seededReuseEnvironmentRow =
    seededReuseLookupId !== null &&
    seededReuseEnvironmentQuery.data?.id === seededReuseLookupId &&
    seededReuseEnvironmentQuery.data.status !== "destroyed"
      ? seededReuseEnvironmentQuery.data
      : null;
  const seededReuseEnvironment = useMemo<SeededReuseEnvironment | null>(() => {
    if (seededReuseEnvironmentId === null) return null;
    if (seededReuseIsThreadDerived) {
      return { environmentId: seededReuseEnvironmentId, status: "available" };
    }
    if (seededReuseEnvironmentQuery.isPending) {
      return { environmentId: seededReuseEnvironmentId, status: "pending" };
    }
    return {
      environmentId: seededReuseEnvironmentId,
      status: seededReuseEnvironmentRow === null ? "missing" : "available",
    };
  }, [
    seededReuseEnvironmentId,
    seededReuseEnvironmentQuery.isPending,
    seededReuseEnvironmentRow,
    seededReuseIsThreadDerived,
  ]);
  const reuseThreadOptions = useMemo(() => {
    if (seededReuseEnvironmentRow === null) return threadDerivedReuseOptions;
    return [
      ...threadDerivedReuseOptions,
      {
        environmentId: seededReuseEnvironmentRow.id,
        branchName: seededReuseEnvironmentRow.branchName,
        name: seededReuseEnvironmentRow.name,
        path: seededReuseEnvironmentRow.path,
        environmentProviderId:
          seededReuseEnvironmentRow.environmentProviderId ?? null,
        hostName:
          worktreeHostNameById?.get(seededReuseEnvironmentRow.hostId) ?? null,
        threads: [],
      },
    ];
  }, [
    seededReuseEnvironmentRow,
    threadDerivedReuseOptions,
    worktreeHostNameById,
  ]);
  const { value: storedMachineId, setValue: setStoredMachineId } =
    usePromptBoxMachinePreference(projectId);
  const [activeSeedSignature, setActiveSeedSignature] = useState(seedSignature);
  const [seedOverridden, setBranchSeedOverridden] = useState(false);
  const [pickedProviderMachine, setPickedProviderMachine] = useState<{
    selectionValue: string;
    machine: EnvironmentMachineSelection;
  } | null>(null);
  if (activeSeedSignature !== seedSignature) {
    setActiveSeedSignature(seedSignature);
    setBranchSeedOverridden(false);
    setPickedProviderMachine(null);
  }

  const resolveProviderSelection = useCallback(
    (
      effectiveValue: string,
    ): {
      provider: SystemEnvironmentProvider;
      machine: EnvironmentMachineSelection | null;
    } | null => {
      const parsedValue = parseEnvironmentValue(effectiveValue);
      if (parsedValue?.type !== "provider") return null;
      const provider = environmentProviders?.find(
        (candidate) => candidate.id === parsedValue.environmentProviderId,
      );
      if (provider === undefined) return null;
      const usable = (hostId: string | null): boolean =>
        hostId !== null &&
        knownHostIds.has(hostId) &&
        (environmentProvidersByHostId
          .get(hostId)
          ?.some(
            (candidate) =>
              candidate.id === provider.id &&
              candidate.availability?.status !== "unavailable",
          ) ??
          false);
      const picked =
        pickedProviderMachine?.selectionValue === effectiveValue
          ? pickedProviderMachine.machine
          : null;
      if (picked !== null) return { provider, machine: picked };
      const seeded =
        !seedOverridden &&
        environmentSeed !== null &&
        environmentSeed.selectionValue === effectiveValue
          ? environmentSeed.providerMachine
          : null;
      const remembered: EnvironmentMachineSelection | null =
        selectionScope === "new-thread" && storedMachineId !== ""
          ? { type: "existing", hostId: storedMachineId }
          : null;
      const candidate = seeded ?? remembered;
      if (candidate?.type === "existing" && usable(candidate.hostId)) {
        return { provider, machine: candidate };
      }
      return {
        provider,
        machine:
          primaryHostId !== null && usable(primaryHostId)
            ? { type: "existing", hostId: primaryHostId }
            : null,
      };
    },
    [
      seedOverridden,
      environmentSeed,
      environmentProviders,
      environmentProvidersByHostId,
      knownHostIds,
      pickedProviderMachine,
      selectionScope,
      storedMachineId,
      primaryHostId,
    ],
  );

  const resolveProviderRouting = useCallback(
    (environmentSelectionValue: string) => {
      const effectiveValue = resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
        seededReuseEnvironment,
      });
      const providerSelection = resolveProviderSelection(effectiveValue);
      if (providerSelection !== null) {
        return providerSelection.machine?.type !== "existing"
          ? {}
          : { hostId: providerSelection.machine.hostId };
      }
      const parsed = parseEnvironmentValue(effectiveValue);
      return parsed?.type === "reuse" && parsed.environmentId !== null
        ? { environmentId: parsed.environmentId }
        : {};
    },
    [
      environmentProviders,
      isProjectless,
      knownHostIds,
      primaryHostId,
      projectSources,
      resolveProviderSelection,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    ],
  );
  const projectDefaultsQuery = useProjectDefaultExecutionOptions(
    { projectId },
    {
      enabled:
        currentProject !== undefined &&
        currentProject.defaultExecutionOptions === null,
    },
  );
  const projectDefaultsState = resolveNewThreadProjectDefaultsState({
    cachedDefaults: currentProject?.defaultExecutionOptions,
    projectFound: currentProject !== undefined,
    queryData: projectDefaultsQuery.data,
    queryIsError: projectDefaultsQuery.isError,
    queryIsPlaceholderData: projectDefaultsQuery.isPlaceholderData,
    queryIsSuccess: projectDefaultsQuery.isSuccess,
  });
  const projectDefaults =
    projectDefaultsState.status === "resolved"
      ? projectDefaultsState.defaults
      : undefined;
  const projectDefaultsUnavailable =
    projectDefaultsState.status !== "resolved" &&
    (seed?.providerId === undefined ||
      seed?.model === undefined ||
      seed?.reasoningLevel === undefined ||
      seed?.permissionMode === undefined);
  const creationOptions = useThreadCreationOptions({
    scope: selectionScope,
    preferenceProjectId: projectId,
    resetKey: `${projectId}\0${seedSignature}`,
    resolveProviderRouting,
    initialProviderId: seed?.providerId ?? projectDefaults?.providerId,
    preferReadyProviderWhenUnset:
      preferReadyProviderWhenUnset && projectDefaults === null,
    initialModel: seed?.model ?? projectDefaults?.model,
    initialServiceTier: seed?.serviceTier ?? projectDefaults?.serviceTier,
    initialReasoningLevel:
      seed?.reasoningLevel ?? projectDefaults?.reasoningLevel,
    initialPermissionMode:
      seed?.permissionMode ?? projectDefaults?.permissionMode,
    initialEnvironmentSelectionValue: environmentSeed?.selectionValue,
  });
  const {
    activeModel,
    executionInputSources,
    executionOptionsRouting,
    environmentSelectionValue,
    hasMultipleProviders,
    isLoadingModels,
    modelLoadError,
    modelLoadFailed,
    modelOptions,
    moreModelOptions,
    permissionMode,
    permissionModeOptions,
    providerOptions,
    reasoningLevel,
    reasoningOptions,
    selectedModel,
    selectedProviderComposerActions,
    selectedProviderDisplayName,
    selectedProviderId,
    serviceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    setEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
    setPermissionMode,
    setProviderModelReasoning,
    setReasoningLevel,
    setSelectedModel,
    setSelectedProviderId,
    setServiceTier,
    supportsPermissionModeSelection,
    supportsServiceTier,
    clearReuseEnvironment,
  } = creationOptions;
  const selectedThreadModel = activeModel?.model ?? selectedModel;

  const promptDraft = usePromptDraftStorage(draftStorage);
  const promptOptionDraftSnapshotRef = useRef<PromptDraftState | null>(null);
  const snapshotDraftBeforeOptionChange = useCallback(() => {
    const currentDraft = promptDraft.getCurrent();
    promptOptionDraftSnapshotRef.current = isPromptDraftEmpty(currentDraft)
      ? null
      : currentDraft;
  }, [promptDraft]);
  useEffect(() => {
    const preservedDraft = promptOptionDraftSnapshotRef.current;
    if (preservedDraft === null) return;
    promptOptionDraftSnapshotRef.current = null;
    const restoredDraft = restorePromptDraftAfterOptionChange({
      currentDraft: promptDraft.getCurrent(),
      preservedDraft,
    });
    if (restoredDraft !== null) promptDraft.setDraft(restoredDraft);
  });

  const changeEnvironment = useCallback(
    (
      value: string,
      providerTarget: string | EnvironmentMachineSelection | null = null,
    ) => {
      const providerMachine =
        typeof providerTarget === "string"
          ? { type: "existing" as const, hostId: providerTarget }
          : providerTarget;
      const currentProviderMachine =
        pickedProviderMachine?.selectionValue === value
          ? pickedProviderMachine.machine
          : null;
      if (
        Object.is(environmentSelectionValue, value) &&
        JSON.stringify(providerMachine) ===
          JSON.stringify(currentProviderMachine)
      ) {
        return;
      }
      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      setPickedProviderMachine(
        providerMachine === null
          ? null
          : { selectionValue: value, machine: providerMachine },
      );
      if (
        selectionScope === "new-thread" &&
        parseEnvironmentValue(value)?.type === "provider"
      ) {
        setStoredMachineId(
          providerMachine?.type === "existing" ? providerMachine.hostId : "",
        );
      }
      setCreationEnvironmentSelectionValue(value);
    },
    [
      environmentSelectionValue,
      pickedProviderMachine,
      setCreationEnvironmentSelectionValue,
      selectionScope,
      setStoredMachineId,
      snapshotDraftBeforeOptionChange,
    ],
  );
  const effectiveEnvironmentValue = useMemo(
    () =>
      resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
        seededReuseEnvironment,
      }),
    [
      environmentSelectionValue,
      environmentProviders,
      isProjectless,
      knownHostIds,
      primaryHostId,
      projectSources,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    ],
  );
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(effectiveEnvironmentValue),
    [effectiveEnvironmentValue],
  );
  const providerSelection = useMemo(
    () => resolveProviderSelection(effectiveEnvironmentValue),
    [effectiveEnvironmentValue, resolveProviderSelection],
  );
  const selectedEnvironmentProvider = providerSelection?.provider;
  const inputEnvironmentProvider =
    selectedEnvironmentProvider?.environmentProviderId
      ? environmentProviders?.find(
          (provider) =>
            provider.id === selectedEnvironmentProvider.environmentProviderId,
        )
      : selectedEnvironmentProvider;
  const providerMachine = providerSelection?.machine ?? null;
  const providerHostId =
    providerMachine?.type === "existing" ? providerMachine.hostId : null;
  const selectedProviderMachineUnavailable =
    providerHostId !== null &&
    !(
      environmentProvidersByHostId
        .get(providerHostId)
        ?.some(
          (provider) =>
            provider.id === selectedEnvironmentProvider?.id &&
            provider.availability?.status !== "unavailable",
        ) ?? false
    );
  const handleSelectProvider = useCallback(
    (provider: SystemEnvironmentProvider, hostId: string | null) => {
      changeEnvironment(
        encodeProviderValue(provider.id),
        hostId === null ? null : { type: "existing", hostId },
      );
    },
    [changeEnvironment],
  );
  const handleSelectHost = useCallback(
    (hostId: string) => {
      const provider = resolveHostEnvironmentProvider({
        currentProvider: selectedEnvironmentProvider ?? null,
        providers: environmentProvidersByHostId.get(hostId) ?? [],
      });
      if (provider === null) return;
      changeEnvironment(encodeProviderValue(provider.id), {
        type: "existing",
        hostId,
      });
    },
    [
      changeEnvironment,
      environmentProvidersByHostId,
      selectedEnvironmentProvider,
    ],
  );
  const selectHostForNewEnvironment = useCallback(
    (hostId: string) => {
      if (!knownHostIds.has(hostId)) return;
      const currentProviderId =
        parsedEnvironment?.type === "provider"
          ? parsedEnvironment.environmentProviderId
          : null;
      const provider = resolveNewThreadHostEnvironmentProvider({
        currentProviderId,
        providers: environmentProvidersByHostId.get(hostId) ?? [],
      });
      if (provider === null) return;
      changeEnvironment(encodeProviderValue(provider.id), hostId);
    },
    [
      changeEnvironment,
      environmentProvidersByHostId,
      knownHostIds,
      parsedEnvironment,
    ],
  );
  const [environmentProviderInputsOverride, setProviderInputsOverride] =
    useState<{ scopeKey: string; value: JsonValue | null } | null>(null);
  const [environmentProviderInputsBlocked, setProviderInputsBlocked] =
    useState<{ scopeKey: string; reason: string } | null>(null);
  const environmentProviderInputsScopeKey = `${projectId}\0${effectiveEnvironmentValue}\0${providerHostId ?? ""}`;
  const handleProviderInputsChange = useCallback(
    (next: EnvironmentInputsChange) => {
      if (next.status === "blocked") {
        setProviderInputsBlocked((current) => {
          if (
            current?.scopeKey === environmentProviderInputsScopeKey &&
            current.reason === next.reason
          ) {
            return current;
          }
          return {
            scopeKey: environmentProviderInputsScopeKey,
            reason: next.reason,
          };
        });
        return;
      }
      setProviderInputsBlocked(null);
      setProviderInputsOverride((current) => {
        if (
          current?.scopeKey === environmentProviderInputsScopeKey &&
          JSON.stringify(current.value) === JSON.stringify(next.value)
        ) {
          return current;
        }
        return {
          scopeKey: environmentProviderInputsScopeKey,
          value: next.value,
        };
      });
    },
    [environmentProviderInputsScopeKey],
  );
  const activeProviderInputsOverride =
    environmentProviderInputsOverride !== null &&
    environmentProviderInputsOverride.scopeKey ===
      environmentProviderInputsScopeKey
      ? environmentProviderInputsOverride
      : null;
  const activeProviderInputsBlocked =
    environmentProviderInputsBlocked?.scopeKey ===
    environmentProviderInputsScopeKey
      ? environmentProviderInputsBlocked
      : null;
  const InputsControl =
    inputEnvironmentProvider === undefined ||
    inputEnvironmentProvider.inputs === null
      ? undefined
      : ENVIRONMENT_INPUTS_CONTROLS.get(inputEnvironmentProvider.id);
  const submissionProviderInputs = useMemo((): JsonValue | null => {
    if (InputsControl === undefined) return null;
    if (activeProviderInputsOverride !== null) {
      return activeProviderInputsOverride.value;
    }
    return !seedOverridden &&
      environmentSeed !== null &&
      effectiveEnvironmentValue === environmentSeed.selectionValue
      ? environmentSeed.providerInputs
      : null;
  }, [
    InputsControl,
    activeProviderInputsOverride,
    seedOverridden,
    effectiveEnvironmentValue,
    environmentSeed,
  ]);
  const environmentProviderInputsBlocker =
    inputEnvironmentProvider === undefined || InputsControl === undefined
      ? null
      : activeProviderInputsBlocked !== null
        ? activeProviderInputsBlocked.reason
        : submissionProviderInputs === null
          ? `Configure ${inputEnvironmentProvider.displayName}`
          : null;
  const environmentProviderInputsSlot = useMemo(() => {
    if (InputsControl === undefined) return null;
    return (
      <InputsControl
        projectId={isProjectless ? null : projectId}
        target={
          providerHostId === null
            ? { kind: "new-host" }
            : { kind: "existing-host", hostId: providerHostId }
        }
        value={submissionProviderInputs}
        onChange={handleProviderInputsChange}
      />
    );
  }, [
    InputsControl,
    handleProviderInputsChange,
    isProjectless,
    projectId,
    providerHostId,
    submissionProviderInputs,
  ]);

  const selectedEnvironment = useMemo(
    () =>
      resolveRootComposeThreadEnvironment({
        environmentValue: effectiveEnvironmentValue,
        projectId,
        environmentProviders,
        providerMachine,
        providerInputs: submissionProviderInputs,
      }),
    [
      effectiveEnvironmentValue,
      environmentProviders,
      projectId,
      submissionProviderInputs,
      providerMachine,
    ],
  );

  const initialPromptDraft = useInitialPromptDraft(seed?.initialPrompt ?? null);
  const seedInitialPrompt = promptDraft.restoreIfEmpty;
  const focusPromptBox = useCallback(() => {
    setLocalPromptBoxFocusRequest((current) => (current ?? 0) + 1);
  }, []);
  useEffect(() => {
    if (!initialPromptDraft?.text) return;
    seedInitialPrompt(initialPromptDraft);
  }, [initialPromptDraft, seedInitialPrompt]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCopyingAttachments, setIsCopyingAttachments] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingUploadCountRef = useRef(0);
  const isCopyingAttachmentsRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const uploadPromptAttachment = useUploadPromptAttachment();
  const uploadTargetKey = `${projectId}\0${promptDraft.storageKey}`;
  const { pendingUploads, startUploads, finishUploads } =
    usePendingAttachmentUploads(uploadTargetKey);
  const currentUploadTargetRef = useRef(uploadTargetKey);
  useEffect(() => {
    currentUploadTargetRef.current = uploadTargetKey;
  }, [uploadTargetKey]);
  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (!projectId || files.length === 0) return;
      const capturedTarget = `${projectId}\0${promptDraft.storageKey}`;
      setAttachmentError(null);
      pendingUploadCountRef.current += 1;
      setIsUploading(true);
      const uploads = startUploads(files);
      try {
        for (const upload of uploads) {
          try {
            const uploaded = await uploadPromptAttachment.mutateAsync({
              projectId,
              file: upload.file,
            });
            if (currentUploadTargetRef.current !== capturedTarget) return;
            promptDraft.addAttachment(uploaded);
          } catch (error) {
            if (currentUploadTargetRef.current === capturedTarget) {
              setAttachmentError(
                getMutationErrorMessage({
                  error,
                  fallbackMessage: "Attachment upload failed",
                }),
              );
            }
            break;
          } finally {
            finishUploads([upload]);
          }
        }
      } finally {
        finishUploads(uploads);
        pendingUploadCountRef.current -= 1;
        setIsUploading(pendingUploadCountRef.current > 0);
      }
    },
    [
      projectId,
      promptDraft,
      uploadPromptAttachment,
      startUploads,
      finishUploads,
    ],
  );
  const handleProjectChange = useCallback(
    async (nextProjectId: string | null) => {
      const nextValue = nextProjectId ?? PERSONAL_PROJECT_ID;
      if (nextValue === projectId) return;
      if (
        isCopyingAttachmentsRef.current ||
        pendingUploadCountRef.current > 0 ||
        isSubmittingRef.current
      ) {
        return;
      }
      const attachmentPaths = getProjectStoredPromptAttachmentPaths(
        promptDraft.getCurrent().attachments,
      );
      isCopyingAttachmentsRef.current = true;
      setIsCopyingAttachments(true);
      try {
        if (attachmentPaths.length > 0) {
          setAttachmentError(null);
          try {
            await sdk.projects.attachments.copy({
              projectId: nextValue,
              sourceProjectId: projectId,
              paths: attachmentPaths,
            });
          } catch (error) {
            setAttachmentError(
              getMutationErrorMessage({
                error,
                fallbackMessage:
                  "Attachments could not be moved to the selected project",
              }),
            );
            return;
          }
        }
        snapshotDraftBeforeOptionChange();
        await onProjectChange(nextValue);
      } finally {
        isCopyingAttachmentsRef.current = false;
        setIsCopyingAttachments(false);
      }
    },
    [onProjectChange, projectId, promptDraft, snapshotDraftBeforeOptionChange],
  );

  const reuseEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;
  const projectHostId =
    reuseEnvironmentId !== null ? null : (providerHostId ?? primaryHostId);
  const panelThreadId = resolvePanelThreadId(
    reuseEnvironmentId,
    reuseThreadOptions,
  );
  const promptMentions = usePromptMentions(
    isProjectless ? undefined : projectId,
    {
      environmentId: reuseEnvironmentId,
      hostId: projectHostId,
      threadStorageThreadId: panelThreadId ?? undefined,
    },
  );
  const defaultMentionLinkResolver = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      return null;
    },
    [navigate, projectId],
  );
  const [commandState, setCommandState] = useState<{
    query: string | null;
    trigger: import("@bb/domain").PromptMentionCommandTrigger | null;
  }>({ query: null, trigger: null });
  const [hasComposerFocused, setHasComposerFocused] = useState(false);
  const handleEditorFocus = useCallback(() => {
    setHasComposerFocused(true);
  }, []);
  const providerPromptActions = useMemo(
    () => buildProviderPromptActionProps(selectedProviderComposerActions),
    [selectedProviderComposerActions],
  );
  const { promptActions } = providerPromptActions;
  const commandSuggestions = useCommandSuggestions({
    projectId,
    providerId: selectedProviderId,
    commandScope: "new-thread",
    skillsTriggers: providerPromptActions.skillsTriggers,
    activeTrigger: commandState.trigger,
    promptActions,
    environmentId: reuseEnvironmentId,
    hostId: projectHostId,
    query: commandState.query,
    composerFocused: hasComposerFocused,
  });
  const promptHistoryEnabled = usePromptHistoryEnabled();
  const { data: projectPromptHistory = [] } = useProjectPromptHistory(
    projectId,
    { enabled: promptHistoryEnabled && sidebarNavigationSettled },
  );
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(projectPromptHistory),
    [projectPromptHistory],
  );
  const currentDraft = useMemo(
    () => ({
      text: promptDraft.text,
      mentions: promptDraft.mentions,
      attachments: promptDraft.attachments,
    }),
    [promptDraft.attachments, promptDraft.mentions, promptDraft.text],
  );
  const promptInput = useMemo(
    () => promptDraftToInput(currentDraft),
    [currentDraft],
  );
  const seededExecutionInputSources = useMemo(
    (): CreateExecutionInputSources => ({
      ...(seed?.providerId !== undefined
        ? { providerId: "explicit" as const }
        : {}),
      ...(seed?.model !== undefined ? { model: "explicit" as const } : {}),
      ...(seed?.reasoningLevel !== undefined
        ? { reasoningLevel: "explicit" as const }
        : {}),
      ...(seed?.serviceTier !== undefined && supportsServiceTier && serviceTier
        ? { serviceTier: "explicit" as const }
        : {}),
      ...(seed?.permissionMode !== undefined
        ? { permissionMode: "explicit" as const }
        : {}),
    }),
    [
      seed?.model,
      seed?.permissionMode,
      seed?.providerId,
      seed?.reasoningLevel,
      seed?.serviceTier,
      serviceTier,
      supportsServiceTier,
    ],
  );
  const submissionEnvironment = selectedProviderMachineUnavailable
    ? null
    : (selectedEnvironment ??
      (selectionScope === "new-thread" ? seed?.environment : undefined) ??
      null);
  const submitDisabledReason = resolveNewThreadSubmitDisabledReason({
    environmentProviderInputsBlocker,
    isCopyingAttachments,
    isLoadingModels,
    isSubmitting,
    isUploading,
    modelLoadError,
    projectDefaultsStatus: projectDefaultsState.status,
    projectDefaultsUnavailable,
    promptInputEmpty: promptInput.length === 0,
    providerDisplayName: selectedProviderDisplayName,
    selectedProviderId,
    selectedThreadModel,
    submissionEnvironmentUnavailable: submissionEnvironment === null,
  });
  const submitDraft = useCallback(async () => {
    const submittedDraft = promptDraft.getCurrent();
    const input = promptDraftToInput(submittedDraft);
    if (
      submitDisabledReason !== null ||
      input.length === 0 ||
      isSubmittingRef.current ||
      projectDefaultsUnavailable ||
      submissionEnvironment === null ||
      !selectedProviderId ||
      !selectedThreadModel
    ) {
      throw new Error(
        submitDisabledReason ??
          (input.length === 0
            ? "Type a message first."
            : "This composer is not ready to submit yet."),
      );
    }
    const sources: CreateExecutionInputSources = {
      ...executionInputSources,
      ...seededExecutionInputSources,
    };
    const request: NewThreadComposerSubmission = {
      projectId,
      providerId: selectedProviderId,
      model: selectedThreadModel,
      reasoningLevel,
      permissionMode,
      ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
      executionInputSources: resolveSubmittedExecutionSources(
        submissionEnvironment,
        sources,
      ),
      environment: submissionEnvironment,
      input,
    };
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setAttachmentError(null);
    const clearedSubmittedDraft =
      promptDraft.clearIfCurrentMatches(submittedDraft);
    try {
      await onSubmit(request);
      clearReuseEnvironment();
    } catch (submitError) {
      if (clearedSubmittedDraft) {
        promptDraft.restoreIfEmpty(submittedDraft);
      }
      throw submitError;
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    clearReuseEnvironment,
    executionInputSources,
    onSubmit,
    permissionMode,
    projectDefaultsUnavailable,
    projectId,
    promptDraft,
    reasoningLevel,
    seededExecutionInputSources,
    submitDisabledReason,
    submissionEnvironment,
    selectedProviderId,
    selectedThreadModel,
    serviceTier,
    supportsServiceTier,
  ]);

  const handleSubmit = useCallback(async () => {
    try {
      await submitDraft();
    } catch {}
  }, [submitDraft]);

  const handleProviderChange = useDraftPreservingOptionChange(
    selectedProviderId,
    setSelectedProviderId,
    snapshotDraftBeforeOptionChange,
  );
  const handleModelChange = useDraftPreservingOptionChange(
    selectedModel,
    setSelectedModel,
    snapshotDraftBeforeOptionChange,
  );
  const handleReasoningChange = useDraftPreservingOptionChange(
    reasoningLevel,
    setReasoningLevel,
    snapshotDraftBeforeOptionChange,
  );
  const handlePermissionChange = useDraftPreservingOptionChange(
    permissionMode,
    setPermissionMode,
    snapshotDraftBeforeOptionChange,
  );
  const handleServiceTierChange = useDraftPreservingOptionChange(
    serviceTier,
    setServiceTier,
    snapshotDraftBeforeOptionChange,
  );
  const handleWorktreeChange = useCallback(
    (environmentId: string) => {
      changeEnvironment(encodeReuseValue(environmentId));
    },
    [changeEnvironment],
  );
  const handleSelectReuse = useCallback(() => {
    changeEnvironment(REUSE_VALUE_WITHOUT_ENVIRONMENT);
  }, [changeEnvironment]);

  const pluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      getCurrent: promptDraft.getCurrent,
      setDraft: promptDraft.setDraft,
      focus: focusPromptBox,
    }),
    [focusPromptBox, promptDraft.getCurrent, promptDraft.setDraft],
  );

  const restoreHistoryDraft = useCallback(
    (draft: PromptDraftState) =>
      createCoreComposerActions(pluginComposerHost).restoreDraft(draft),
    [pluginComposerHost],
  );

  const renderPromptBox = useCallback(
    (options: NewThreadComposerPromptOptions) => {
      const locks = options.locks ?? {};
      return (
        <NewThreadPromptBox
          id={options.id}
          focusRequest={promptBoxFocusRequest}
          value={promptDraft.text}
          mentionRanges={promptDraft.mentions}
          onChange={promptDraft.setTextAndMentions}
          onSubmit={() => void handleSubmit()}
          isSubmitting={isSubmitting}
          disabled={submitDisabledReason !== null}
          disabledReason={submitDisabledReason ?? undefined}
          placeholder={options.placeholder}
          mentionMenuPlacement={options.mentionMenuPlacement}
          autoFocus={options.autoFocus}
          pluginComposerHost={options.pluginComposerHost ?? pluginComposerHost}
          history={{
            currentDraft,
            entries: promptHistoryDrafts,
            onSelectEntry: restoreHistoryDraft,
            resetKey: projectId,
          }}
          typeahead={{
            mention: {
              triggers: promptMentions.triggers,
              results: promptMentions.results,
              isLoading: promptMentions.isLoading,
              isError: promptMentions.isError,
              onQueryChange: promptMentions.setQuery,
              resolveLink:
                options.resolveMentionLink ?? defaultMentionLinkResolver,
            },
            command: {
              triggers: commandSuggestions.triggers,
              suggestions: commandSuggestions.suggestions,
              isLoading: commandSuggestions.isLoading,
              isError: commandSuggestions.isError,
              hasMore: commandSuggestions.hasMore,
              isLoadingMore: commandSuggestions.isLoadingMore,
              loadMore: commandSuggestions.loadMore,
              onQueryChange: (query, trigger) =>
                setCommandState({ query, trigger }),
              onEditorFocus: handleEditorFocus,
            },
          }}
          attachments={{
            items: promptDraft.attachments,
            pendingUploads,
            projectId,
            onAttachFiles: handleAttachFiles,
            onRemove: promptDraft.removeAttachment,
            isAttaching: isUploading || isCopyingAttachments,
            error: attachmentError,
          }}
          promptActions={promptActions}
          modeConfig={{
            environment: {
              value: effectiveEnvironmentValue,
              sources: projectSources,
              disabled: locks.environment,
              isLoading: environmentProviders === undefined,
              providers: environmentProviders ?? [],
              providersByHostId: environmentProvidersByHostId,
              selectedProviderHostId: providerHostId,
              onSelectProvider: handleSelectProvider,
              onSelectHost: handleSelectHost,
              onSelectReuse: handleSelectReuse,
              ...(!isProjectless && options.onRequestMachineSetup
                ? { onRequestMachineSetup: options.onRequestMachineSetup }
                : {}),
            },
            worktree: {
              options: reuseThreadOptions,
              value: reuseEnvironmentId,
              onChange: handleWorktreeChange,
              disabled: locks.environment,
            },
            permission: {
              value: permissionMode,
              options: permissionModeOptions,
              onChange: handlePermissionChange,
              supported: supportsPermissionModeSelection,
            },
            environmentProviderInputsSlot,
            header: options.header,
          }}
          project={{
            projects: projectOptions,
            value: options.allowNoProject && isProjectless ? null : projectId,
            onChange: handleProjectChange,
            allowNoProject: options.allowNoProject,
            createProject: options.createProject,
            isLoading: !sidebarNavigationSettled,
            disabled:
              locks.project ||
              isUploading ||
              isCopyingAttachments ||
              isSubmitting,
            showChevronWhenDisabled: !locks.project,
          }}
          execution={{
            providerRouting: executionOptionsRouting,
            provider: {
              options: providerOptions,
              selectedId: selectedProviderId,
              onChange: locks.provider ? undefined : handleProviderChange,
              hasMultiple: hasMultipleProviders,
            },
            model: {
              active: activeModel,
              selected: selectedModel,
              options: modelOptions,
              moreOptions: moreModelOptions,
              isLoading: isLoadingModels,
              loadFailed: modelLoadFailed,
              loadError: modelLoadError,
              onChange: handleModelChange,
            },
            serviceTier: {
              value: serviceTier,
              onChange: handleServiceTierChange,
              supported: supportsServiceTier,
              supportByProvider: serviceTierSupportByProvider,
              fastLabel: serviceTierFastLabel,
            },
            reasoning: {
              value: reasoningLevel,
              options: reasoningOptions,
              onChange: handleReasoningChange,
            },
          }}
        />
      );
    },
    [
      activeModel,
      attachmentError,
      commandSuggestions,
      currentDraft,
      defaultMentionLinkResolver,
      effectiveEnvironmentValue,
      environmentProviders,
      environmentProvidersByHostId,
      executionOptionsRouting,
      handleAttachFiles,
      handleEditorFocus,
      handleModelChange,
      handlePermissionChange,
      handleProjectChange,
      handleProviderChange,
      handleReasoningChange,
      handleSelectProvider,
      handleSelectHost,
      handleSelectReuse,
      handleServiceTierChange,
      handleSubmit,
      handleWorktreeChange,
      hasMultipleProviders,
      isCopyingAttachments,
      isLoadingModels,
      isProjectless,
      isSubmitting,
      isUploading,
      pendingUploads,
      modelLoadError,
      modelLoadFailed,
      modelOptions,
      moreModelOptions,
      permissionMode,
      permissionModeOptions,
      projectId,
      projectOptions,
      projectSources,
      promptActions,
      promptBoxFocusRequest,
      promptDraft,
      promptHistoryDrafts,
      restoreHistoryDraft,
      promptMentions,
      pluginComposerHost,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      reuseEnvironmentId,
      reuseThreadOptions,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      sidebarNavigationSettled,
      supportsPermissionModeSelection,
      supportsServiceTier,
      submitDisabledReason,
      environmentProviderInputsSlot,
      providerHostId,
      serviceTierFastLabel,
    ],
  );

  return (
    <NewThreadComposerStateRenderer
      render={children}
      state={{
        projectId,
        isProjectless,
        projects,
        sidebarNavigation: sidebarNavigationQuery.data,
        sidebarNavigationError: sidebarNavigationQuery.isError,
        currentProject,
        projectSources,
        connectedHostIds,
        primaryHostId,
        parsedEnvironment,
        projectHostId,
        panelThreadId,
        promptDraft,
        focusPromptBox,
        pluginComposerHost,
        isSubmitting,
        seedEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
        hostSelectionReady:
          sidebarNavigationSettled &&
          !hostsQuery.isPending &&
          registeredEnvironmentProviders !== undefined &&
          projectEnvironmentProviders !== undefined,
        selectHostForNewEnvironment,
        setEnvironmentSelectionValue: changeEnvironment,
        setProviderModelReasoning,
        setPermissionMode,
        setServiceTier,
        renderPromptBox,
      }}
    />
  );
}
