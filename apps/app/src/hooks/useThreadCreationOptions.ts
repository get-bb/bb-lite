import { useState } from "react";
import { useAtom } from "jotai";
import {
  permissionModeRank,
  providerModelCatalogDependsOnWorkspace,
  reconcileReasoningLevel,
  type AvailableModel,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type {
  CreateExecutionInputSources,
  ExecutionInputFieldSource,
  SystemProvidersQuery,
} from "@bb/server-contract";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
  ProviderPickerOption,
} from "@/components/pickers/ModelReasoningPicker";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { getProviderIconInfo } from "@/lib/provider-icon";
import {
  fastServiceTierLabel,
  reasoningLevelLabel,
} from "@/lib/reasoning-labels";
import { selectPrimaryHost, useHosts } from "./queries/host-queries";
import {
  useKnownProviderModelCatalogScope,
  useSystemConfig,
  useSystemExecutionOptions,
} from "./queries/system-queries";
import {
  storedModelAtomFamily,
  storedPermissionModeAtom,
  storedProviderIdAtom,
  storedReasoningLevelAtomFamily,
  storedServiceTierAtom,
} from "./thread-creation-options/persisted-selection-fields";

const PERMISSION_CEILING_REASON =
  "Above the selected machine's permission limit. Change it in Settings → Machines.";

interface ThreadCreationSelections {
  providerId: string;
  model: string;
  serviceTier: ServiceTier | undefined;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
}

type ThreadCreationField = keyof ThreadCreationSelections;

interface UseThreadCreationOptionsArgs {
  enabled?: boolean;
  scope?: "new-thread" | "component-local";
  environmentId?: string;
  environmentHostId?: string;
  routing?: SystemProvidersQuery;
  resetKey?: string | number | null;
  initialProviderId?: string;
  initialModel?: string;
  initialServiceTier?: ServiceTier;
  initialReasoningLevel?: ReasoningLevel;
  initialPermissionMode?: PermissionMode;
}

function formatModelLabel(value: string): string {
  return value
    .split("-")
    .map((part) =>
      part.toLowerCase() === "gpt"
        ? "GPT"
        : /^[a-z]+$/i.test(part)
          ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
          : part,
    )
    .join("-");
}

function reconcileModelReasoningLevel(
  model: AvailableModel | undefined,
  preferred: ReasoningLevel,
): ReasoningLevel {
  const supported =
    model?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort) ??
    [];
  return supported.length === 0
    ? preferred
    : reconcileReasoningLevel(preferred, supported);
}

function resolveModelCatalogSelection({
  models,
  selectedOnlyModels,
  rawSelectedModel,
  catalogIsVerified,
}: {
  models: readonly AvailableModel[];
  selectedOnlyModels: readonly AvailableModel[];
  rawSelectedModel: string;
  catalogIsVerified: boolean;
}) {
  const fullCatalog = [...models, ...selectedOnlyModels];
  const suffixMatches = fullCatalog.filter((model) =>
    model.model.endsWith(`/${rawSelectedModel}`),
  );
  const requested =
    rawSelectedModel.length === 0 ||
    fullCatalog.some((model) => model.model === rawSelectedModel) ||
    suffixMatches.length !== 1
      ? rawSelectedModel
      : suffixMatches[0]!.model;
  const requestedOnly = models.some((model) => model.model === requested)
    ? undefined
    : selectedOnlyModels.find((model) => model.model === requested);
  const availableModels = requestedOnly ? [requestedOnly, ...models] : models;
  const fallback =
    availableModels.find((model) => model.isDefault) ?? availableModels[0];
  const selectedModel =
    (!catalogIsVerified && requested) ||
    fallback === undefined ||
    availableModels.some((model) => model.model === requested)
      ? requested
      : fallback.model;
  const toOption = (model: AvailableModel): PickerOption<string> => ({
    value: model.model,
    label: formatModelLabel(model.displayName || model.model),
  });
  return {
    selectedModel,
    activeModel:
      availableModels.find((model) => model.model === selectedModel) ??
      fallback,
    modelOptions: availableModels.map(toOption),
    moreModelOptions: selectedOnlyModels
      .filter(
        (model) =>
          !availableModels.some((active) => active.model === model.model),
      )
      .map(toOption),
    isUnavailableModelRecovery:
      catalogIsVerified &&
      rawSelectedModel.length > 0 &&
      selectedModel !== rawSelectedModel,
  };
}

export function useThreadCreationOptions({
  enabled = true,
  scope = "new-thread",
  environmentId,
  environmentHostId,
  routing,
  resetKey,
  initialProviderId = "",
  initialModel = "",
  initialServiceTier,
  initialReasoningLevel,
  initialPermissionMode = "auto",
}: UseThreadCreationOptionsArgs = {}) {
  const usesStored = scope === "new-thread";
  const [storedProviderId, setStoredProviderId] = useAtom(storedProviderIdAtom);
  const [storedServiceTier, setStoredServiceTier] = useAtom(
    storedServiceTierAtom,
  );
  const [storedPermissionMode, setStoredPermissionMode] = useAtom(
    storedPermissionModeAtom,
  );
  const [local, setLocal] = useState<{
    resetKey: string | number | null | undefined;
    values: Partial<ThreadCreationSelections>;
    touched: readonly ThreadCreationField[];
  }>({ resetKey, values: {}, touched: [] });
  const isStale = !usesStored && local.resetKey !== resetKey;
  if (isStale) setLocal({ resetKey, values: {}, touched: [] });
  const values = isStale ? {} : local.values;
  const touched = isStale ? [] : local.touched;
  const touch = (
    fields: readonly ThreadCreationField[],
    next: Partial<ThreadCreationSelections> = {},
  ) =>
    setLocal((current) => ({
      resetKey,
      values: usesStored ? {} : { ...current.values, ...next },
      touched: [...new Set([...current.touched, ...fields])],
    }));

  const rawProviderId = usesStored
    ? storedProviderId || initialProviderId
    : (values.providerId ?? initialProviderId);
  const modelCatalogScope = useKnownProviderModelCatalogScope(rawProviderId);
  const executionOptionsRouting: SystemProvidersQuery =
    routing ??
    (environmentId === undefined
      ? {}
      : environmentHostId !== undefined &&
          !providerModelCatalogDependsOnWorkspace(modelCatalogScope)
        ? { hostId: environmentHostId }
        : { environmentId });
  const executionOptionsQuery = useSystemExecutionOptions({
    enabled,
    ...executionOptionsRouting,
    providerId: enabled ? rawProviderId || undefined : undefined,
  });
  const hostsQuery = useHosts();
  const systemConfig = useSystemConfig();
  const catalog = executionOptionsQuery.data;
  const providers = catalog?.providers ?? [];
  const modelLoadError = catalog?.modelLoadError ?? null;
  const permissionModeIsVerified =
    catalog !== undefined &&
    !executionOptionsQuery.isPlaceholderData &&
    !executionOptionsQuery.isError;
  const modelCatalogIsVerified =
    permissionModeIsVerified && modelLoadError === null;
  const provider =
    providers.find((candidate) => candidate.id === rawProviderId) ??
    providers[0];
  const providerId = provider?.id ?? "";

  const [storedModel, setStoredModel] = useAtom(
    storedModelAtomFamily(providerId),
  );
  const [storedReasoningLevel, setStoredReasoningLevel] = useAtom(
    storedReasoningLevelAtomFamily(providerId),
  );
  const matchesInitialProvider =
    providerId.length > 0 && providerId === initialProviderId;
  const {
    selectedModel,
    activeModel,
    modelOptions,
    moreModelOptions,
    isUnavailableModelRecovery,
  } = resolveModelCatalogSelection({
    models: catalog?.models ?? [],
    selectedOnlyModels: catalog?.selectedOnlyModels ?? [],
    rawSelectedModel: usesStored
      ? storedModel || (matchesInitialProvider ? initialModel : "")
      : (values.model ?? initialModel),
    catalogIsVerified: modelCatalogIsVerified,
  });
  const reasoningLevel = reconcileModelReasoningLevel(
    activeModel,
    (usesStored
      ? storedReasoningLevel ||
        (matchesInitialProvider ? initialReasoningLevel : undefined)
      : (values.reasoningLevel ?? initialReasoningLevel)) ?? "medium",
  );
  const reasoningOptions = [
    ...new Set(
      activeModel?.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ),
  ].map((level) => ({
    value: level,
    label: reasoningLevelLabel(level, provider),
  }));

  const allowFastServiceTier =
    systemConfig.data?.generalSettings?.allowFastServiceTier ?? true;
  const providerSupportsServiceTier =
    provider?.capabilities.supportsServiceTier ?? false;
  const supportsServiceTier =
    allowFastServiceTier && providerSupportsServiceTier;
  const serviceTier: ServiceTier | undefined = !providerSupportsServiceTier
    ? undefined
    : !allowFastServiceTier
      ? "default"
      : usesStored
        ? storedServiceTier || initialServiceTier
        : "serviceTier" in values
          ? values.serviceTier
          : initialServiceTier;

  const permissionModes: readonly PermissionMode[] = provider?.capabilities
    .permissionModes ?? ["full"];
  const routedHostId =
    executionOptionsRouting.hostId ??
    selectPrimaryHost(hostsQuery.data, systemConfig.data?.primaryHostId ?? null)
      ?.id;
  const permissionCeiling: PermissionMode =
    (executionOptionsQuery.isPlaceholderData
      ? undefined
      : catalog?.permissionCeiling) ??
    hostsQuery.data?.find((host) => host.id === routedHostId)
      ?.maxPermissionMode ??
    "full";
  const exceedsCeiling = (mode: PermissionMode) =>
    permissionModeRank(mode) > permissionModeRank(permissionCeiling);
  const allowedModes = permissionModes.filter((mode) => !exceedsCeiling(mode));
  const selectableModes =
    allowedModes.length > 0 ? allowedModes : permissionModes;
  const rawPermissionMode = usesStored
    ? storedPermissionMode || initialPermissionMode
    : (values.permissionMode ?? initialPermissionMode);
  const permissionMode =
    [rawPermissionMode, "auto" as const, "full" as const].find((mode) =>
      selectableModes.includes(mode),
    ) ??
    selectableModes[0] ??
    "auto";
  const permissionModeOptions: PickerOption<PermissionMode>[] =
    PERMISSION_MODE_OPTIONS.filter((option) =>
      permissionModes.includes(option.value),
    ).map((option) =>
      exceedsCeiling(option.value)
        ? {
            ...option,
            disabled: true,
            disabledReason: PERMISSION_CEILING_REASON,
          }
        : option,
    );

  const anyTouched = touched.length > 0;
  const sourceOf = (
    field: ThreadCreationField,
    isRemembered: boolean,
  ): ExecutionInputFieldSource | undefined =>
    (usesStored ? touched.includes(field) : anyTouched)
      ? "explicit"
      : usesStored && isRemembered
        ? "client-preference"
        : undefined;
  const sources: Record<
    ThreadCreationField,
    ExecutionInputFieldSource | undefined
  > = {
    providerId:
      usesStored && providerId
        ? sourceOf("providerId", storedProviderId === providerId)
        : undefined,
    model:
      selectedModel.length === 0
        ? undefined
        : isUnavailableModelRecovery
          ? "explicit"
          : sourceOf("model", storedModel === selectedModel),
    serviceTier:
      serviceTier === undefined
        ? undefined
        : sourceOf("serviceTier", storedServiceTier === serviceTier),
    reasoningLevel: sourceOf("reasoningLevel", storedReasoningLevel !== ""),
    permissionMode: sourceOf("permissionMode", storedPermissionMode !== ""),
  };
  const executionInputSources = Object.fromEntries(
    Object.entries(sources).filter(([, source]) => source !== undefined),
  ) as CreateExecutionInputSources;

  const execution: ExecutionControlsProps = {
    provider: {
      options: providers.map((candidate): ProviderPickerOption => ({
        value: candidate.id,
        label: candidate.displayName,
        icon: getProviderIconInfo(candidate.id, candidate)?.icon,
        brandPrefix: candidate.strings?.brandPrefix,
        installUrl: candidate.strings?.installUrl,
      })),
      selectedId: providerId,
      onChange: (value) => {
        if (usesStored) {
          if (providerId.length > 0) {
            setStoredModel(selectedModel);
            setStoredReasoningLevel(reasoningLevel);
          }
          setStoredProviderId(value);
        }
        touch(
          usesStored
            ? ["providerId"]
            : ["providerId", "model", "reasoningLevel"],
          { providerId: value, model: "" },
        );
      },
      hasMultiple: providers.length >= 2,
    },
    model: {
      active: activeModel,
      selected: selectedModel,
      options: modelOptions,
      moreOptions: moreModelOptions,
      isLoading:
        enabled &&
        (executionOptionsQuery.isLoading ||
          (executionOptionsQuery.isPlaceholderData &&
            (catalog?.models.length ?? 0) === 0)),
      loadFailed: executionOptionsQuery.isError || modelLoadError !== null,
      loadError: modelLoadError,
      onChange: (value) => {
        if (usesStored) {
          setStoredModel(value);
          setStoredReasoningLevel(
            reconcileModelReasoningLevel(
              [
                ...(catalog?.models ?? []),
                ...(catalog?.selectedOnlyModels ?? []),
              ].find((model) => model.model === value),
              reasoningLevel,
            ),
          );
        }
        touch(["model"], { model: value });
      },
    },
    serviceTier: {
      value: serviceTier,
      onChange: (value) => {
        if (usesStored) setStoredServiceTier(value ?? "");
        touch(["serviceTier"], { serviceTier: value });
      },
      supported: supportsServiceTier,
      fastLabel: fastServiceTierLabel(provider),
    },
    reasoning: {
      value: reasoningLevel,
      options: reasoningOptions,
      onChange: (value) => {
        if (usesStored) setStoredReasoningLevel(value);
        touch(["reasoningLevel"], { reasoningLevel: value });
      },
    },
  };
  const permission: ExecutionPermissionConfig & { value: PermissionMode } = {
    value: permissionMode,
    options: permissionModeOptions,
    onChange: (value) => {
      if (usesStored) setStoredPermissionMode(value);
      touch(["permissionMode"], { permissionMode: value });
    },
    supported: permissionModes.length > 1,
  };

  return {
    execution,
    permission,
    selectedProviderId: providerId,
    selectedProviderDisplayName: provider?.displayName ?? providerId,
    selectedProviderComposerActions: provider?.composerActions ?? [],
    selectedModel,
    serviceTier,
    reasoningLevel,
    activeModel,
    isLoadingModels: execution.model.isLoading,
    modelLoadError,
    supportsServiceTier,
    executionInputSources,
  };
}
