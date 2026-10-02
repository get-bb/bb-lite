import { useEffect, useMemo } from "react";
import type {
  PermissionModePickerProps,
  ProviderModelPickerProps,
  ProviderModelPickerRouting,
  ProviderModelPickerValue,
} from "@bb/plugin/app";
import { ModelReasoningPicker } from "@/components/pickers/ModelReasoningPicker";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  formatModelLabel,
  useThreadCreationOptions,
} from "@/hooks/useThreadCreationOptions";

function useRouting(routing: ProviderModelPickerRouting | undefined) {
  return useMemo(
    () =>
      routing?.kind === "host"
        ? { key: `host:${routing.hostId}`, query: { hostId: routing.hostId } }
        : routing?.kind === "environment"
          ? {
              key: `environment:${routing.environmentId}`,
              query: { environmentId: routing.environmentId },
            }
          : { key: "primary", query: {} },
    [routing],
  );
}

function selectionKey(value: ProviderModelPickerValue): string {
  return [
    value.providerId,
    value.model,
    value.reasoningLevel,
    value.serviceTier ?? "",
  ].join("\0");
}

export function PluginProviderModelPicker({
  value,
  onChange,
  routing,
  allowProviderChange = true,
  align = "start",
  disabled,
  className,
}: ProviderModelPickerProps) {
  const { key, query } = useRouting(routing);
  const controller = useThreadCreationOptions({
    scope: "component-local",
    initialProviderId: value.providerId,
    initialModel: value.model,
    initialReasoningLevel: value.reasoningLevel,
    initialServiceTier: value.serviceTier,
    resetKey: `${key}\0${selectionKey(value)}`,
    resolveProviderRouting: () => query,
  });
  const {
    modelCatalogIsVerified: verified,
    selectedProviderId: providerId,
    selectedModel: model,
    reasoningLevel,
    serviceTier,
  } = controller;
  const valueKey = selectionKey(value);
  const emit = (next: ProviderModelPickerValue) => {
    if (selectionKey(next) !== valueKey) onChange(next);
  };
  const current = (patch: Partial<ProviderModelPickerValue>) =>
    emit({
      providerId,
      model,
      reasoningLevel,
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...patch,
    });
  useEffect(() => {
    if (!verified || model.length === 0) return;
    const next = {
      providerId,
      model,
      reasoningLevel,
      ...(serviceTier === undefined ? {} : { serviceTier }),
    };
    if (selectionKey(next) !== valueKey) onChange(next);
  }, [
    verified,
    providerId,
    model,
    reasoningLevel,
    serviceTier,
    valueKey,
    onChange,
  ]);
  return (
    <ModelReasoningPicker
      providerOptions={controller.providerOptions}
      providerRouting={controller.executionOptionsRouting}
      selectedProviderId={providerId}
      onSelectedProviderChange={allowProviderChange ? () => {} : undefined}
      onProviderPreviewResolved={
        allowProviderChange
          ? (selection) =>
              emit({
                providerId: selection.providerId,
                model: selection.model,
                reasoningLevel: selection.reasoningLevel,
                ...(selection.supportsServiceTier &&
                value.serviceTier !== undefined
                  ? { serviceTier: value.serviceTier }
                  : {}),
              })
          : undefined
      }
      requireVerifiedProviderPreview={allowProviderChange}
      hasMultipleProviders={controller.hasMultipleProviders}
      modelValue={model}
      modelOptions={controller.modelOptions}
      moreModelOptions={controller.moreModelOptions}
      modelIsLoading={controller.isLoadingModels}
      modelLoadFailed={controller.modelLoadFailed}
      modelLoadError={controller.modelLoadError}
      onModelChange={(next) => {
        if (verified) controller.setSelectedModel(next);
      }}
      formatModelLabel={formatModelLabel}
      reasoningValue={reasoningLevel}
      reasoningOptions={controller.reasoningOptions}
      onReasoningChange={(next) => {
        if (verified) current({ reasoningLevel: next });
      }}
      fastModeEnabled={serviceTier === "fast"}
      onFastModeChange={(enabled) => {
        if (verified && controller.supportsServiceTier)
          current({ serviceTier: enabled ? "fast" : "default" });
      }}
      showFastModeToggle={controller.supportsServiceTier}
      serviceTierSupportByProvider={controller.serviceTierSupportByProvider}
      commandShortcutsEnabled={false}
      align={align}
      disabled={disabled}
      className={className}
    />
  );
}

export function PluginPermissionModePicker({
  providerId,
  value,
  onChange,
  routing,
  align = "end",
  disabled,
  className,
}: PermissionModePickerProps) {
  const { key, query } = useRouting(routing);
  const controller = useThreadCreationOptions({
    scope: "component-local",
    initialProviderId: providerId,
    initialPermissionMode: value,
    resetKey: `${key}\0${providerId}\0${value}`,
    resolveProviderRouting: () => query,
  });
  const { permissionMode, permissionModeIsVerified: verified } = controller;
  const providerMatches =
    providerId.length > 0 && controller.selectedProviderId === providerId;
  useEffect(() => {
    if (providerMatches && verified && permissionMode !== value)
      onChange(permissionMode);
  }, [permissionMode, verified, onChange, providerMatches, value]);
  if (!providerMatches) return null;
  return (
    <PermissionModePicker
      value={permissionMode}
      options={controller.permissionModeOptions}
      onChange={onChange}
      supported={controller.permissionModeOptions.length > 0}
      showWhenSingleOption
      align={align}
      disabled={disabled || !verified}
      className={className}
    />
  );
}
